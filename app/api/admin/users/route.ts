import { requireRole, toObjectId } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import type { RotationImport, RotationImportRow, User } from "@/lib/models/types";
import { createBulkAccount, generateLoginId } from "@/lib/account-factory";
import { normalizePhone } from "@/lib/roster-import";
import { ObjectId } from "mongodb";

// Admin user management. GET lists all users; POST handles both
// single-user creation and Excel rotation bulk import.
export async function GET() {
  const session = await requireRole(["admin"]);
  if (!session) return Response.json({ error: "Admin only" }, { status: 403 });

  const db = await getDb();
  const users = await db
    .collection<User>("users")
    .find({})
    .project({ passwordHash: 0 })
    .sort({ createdAt: -1 })
    .toArray();
  return Response.json(users);
}

export async function POST(req: Request) {
  const session = await requireRole(["admin"]);
  if (!session) return Response.json({ error: "Admin only" }, { status: 403 });
  const adminId = toObjectId((session.user as any).id);

  const db = await getDb();
  const contentType = req.headers.get("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    return await handleRotationImport(req, adminId);
  }

  // Single manual user creation (used by rotation import fallback too).
  // Phone is the canonical identity key: dedupe by phone first, then email.
  const body = await req.json();
  const { fullName, email, role, password, phone } = body;
  if (!fullName || !role) {
    return Response.json({ error: "fullName and role are required" }, { status: 400 });
  }
  if (!email && !phone) {
    return Response.json({ error: "email or phone is required" }, { status: 400 });
  }

  const normalizedPhone = phone ? normalizePhone(String(phone)) : "";
  const loginId = email ? String(email).trim().toLowerCase() : generateLoginId(normalizedPhone);

  const existing =
    (normalizedPhone ? await db.collection<User>("users").findOne({ phone: normalizedPhone }) : null) ||
    (email ? await db.collection<User>("users").findOne({ loginId: loginId }) : null);
  if (existing) return Response.json({ error: "Account already exists for that phone or email" }, { status: 409 });

  const bcrypt = await import("bcryptjs");
  const now = new Date();
  const user: User = {
    fullName,
    role,
    loginId,
    email: email ? String(email).trim().toLowerCase() : null,
    ...(normalizedPhone ? { phone: normalizedPhone } : {}),
    passwordHash: await bcrypt.hash(password || "ChangeMe123", 10),
    accountType: "bulk-generated",
    status: "active",
    approvedBy: adminId,
    approvedAt: now,
    mustChangePassword: true,
    expiresAt: new Date(now.getTime() + 50 * 24 * 60 * 60 * 1000),
    rotationImportId: null,
    createdAt: now,
    updatedAt: now,
  };
  const res = await db.collection<User>("users").insertOne(user);

  await logAudit({
    collection: "users",
    documentId: res.insertedId,
    action: "create",
    summary: `Admin created user ${fullName} (${loginId}, ${role})`,
    performedBy: adminId,
  });

  return Response.json({ ...user, _id: res.insertedId, password: password || "ChangeMe123" }, { status: 201 });
}

// Parse an Excel rotation file (columns: name, email, number) and create
// intern accounts with 50-day expiry + forced password change (spec 10.3).
// Phone is the canonical identity key — a row whose phone already has an
// account is reported as "existing", never duplicated. Email is optional;
// people log in with the generated loginId (e.g. hpb01123456789).
async function handleRotationImport(req: Request, adminId: any) {
  const formData = await req.formData();
  const file = formData.get("file") as File;
  if (!file) return Response.json({ error: "No file provided" }, { status: 400 });

  const XLSX = await import("xlsx");
  const buffer = Buffer.from(await file.arrayBuffer());
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: "" });

  const db = await getDb();
  const now = new Date();
  const importId = new ObjectId();
  const usedLoginIds = new Set<string>();

  const importRows: RotationImportRow[] = [];
  let created = 0;
  let existing = 0;

  for (const row of rows) {
    const name = (row["name"] || row["Name"] || "").trim();
    const email = (row["email"] || row["Email"] || "").trim();
    const number = (row["number"] || row["Number"] || "").trim();

    if (!name) {
      importRows.push({ name, email, number, status: "error", errorReason: "Missing name" });
      continue;
    }
    if (!number && !email) {
      importRows.push({ name, email, number, status: "error", errorReason: "Missing phone and email" });
      continue;
    }

    // Email-only fallback: existing accounts log in with their email as loginId.
    if (!number && email) {
      const byLogin = await db.collection<User>("users").findOne({ loginId: email.toLowerCase() });
      if (byLogin) {
        importRows.push({
          name,
          email,
          number,
          generatedUserId: byLogin._id!.toString(),
          generatedLoginId: byLogin.loginId,
          status: "existing",
        });
        existing++;
        continue;
      }
    }

    const result = await createBulkAccount(db, {
      fullName: name,
      phone: number,
      email,
      role: "intern",
      rotationImportId: importId,
      approvedBy: adminId,
      usedLoginIds,
    });

    if (result.status === "existing") {
      importRows.push({
        name,
        email,
        number,
        generatedUserId: result.user._id!.toString(),
        generatedLoginId: result.loginId,
        status: "existing",
      });
      existing++;
    } else {
      created++;
      importRows.push({
        name,
        email,
        number,
        generatedUserId: result.user._id!.toString(),
        generatedLoginId: result.loginId,
        generatedPassword: result.password,
        status: "created",
      });
    }
  }

  const importDoc: RotationImport = {
    _id: importId,
    uploadedBy: adminId,
    uploadedAt: now,
    sourceFileName: file.name,
    rows: importRows,
  };
  await db.collection<RotationImport>("rotationImports").insertOne(importDoc);

  await logAudit({
    collection: "rotationImports",
    documentId: importId,
    action: "create",
    summary: `Rotation import "${file.name}": ${created} created, ${existing} already existed, ${importRows.length} total rows`,
    performedBy: adminId,
  });

  return Response.json(
    {
      total: rows.length,
      created,
      existing,
      failed: rows.length - created - existing,
      rows: importRows,
      importId,
    },
    { status: created ? 201 : 200 }
  );
}
