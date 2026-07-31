import { requireRole } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { toObjectId } from "@/lib/api";
import type { RotationImport, RotationImportRow, User } from "@/lib/models/types";

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

  // Single manual user creation (used by rotation import fallback too)
  const body = await req.json();
  const { fullName, email, role, password } = body;
  if (!fullName || !email || !role) {
    return Response.json({ error: "fullName, email and role are required" }, { status: 400 });
  }

  const existing = await db.collection<User>("users").findOne({ email });
  if (existing) return Response.json({ error: "Email already registered" }, { status: 409 });

  const bcrypt = await import("bcryptjs");
  const now = new Date();
  const user: User = {
    fullName,
    role,
    email,
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
    summary: `Admin created user ${fullName} (${email}, ${role})`,
    performedBy: adminId,
  });

  return Response.json({ ...user, _id: res.insertedId, password: password || "ChangeMe123" }, { status: 201 });
}

// Parse an Excel rotation file (columns: name, email, number, optional role)
// and create users with 50-day expiry + forced password change (spec 10.3).
async function handleRotationImport(req: Request, adminId: any) {
  const formData = await req.formData();
  const file = formData.get("file") as File;
  if (!file) return Response.json({ error: "No file provided" }, { status: 400 });

  const XLSX = await import("xlsx");
  const buffer = Buffer.from(await file.arrayBuffer());
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: "" });

  const bcrypt = await import("bcryptjs");
  const db = await getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 50 * 24 * 60 * 60 * 1000);

  const importRows: RotationImportRow[] = [];
  let created = 0;

  for (const row of rows) {
    const name = (row["name"] || row["Name"] || "").trim();
    const email = (row["email"] || row["Email"] || "").trim().toLowerCase();
    const number = (row["number"] || row["Number"] || "").trim();

    if (!name || !email) {
      importRows.push({ name, email, number, status: "error", errorReason: "Missing name or email" });
      continue;
    }

    const existing = await db.collection<User>("users").findOne({ email });
    if (existing) {
      importRows.push({ name, email, number, status: "error", errorReason: "Email already exists" });
      continue;
    }

    const password = `Hpb@${number || Math.random().toString(36).slice(2, 8)}`;
    const user: User = {
      fullName: name,
      role: "intern",
      email,
      passwordHash: await bcrypt.hash(password, 10),
      accountType: "bulk-generated",
      status: "active",
      approvedBy: adminId,
      approvedAt: now,
      mustChangePassword: true,
      expiresAt,
      rotationImportId: null,
      createdAt: now,
      updatedAt: now,
    };
    const res = await db.collection<User>("users").insertOne(user);
    created++;
    importRows.push({
      name,
      email,
      number,
      generatedUserId: res.insertedId.toString(),
      generatedPassword: password,
      status: "created",
    });
  }

  const importDoc: RotationImport = {
    uploadedBy: adminId,
    uploadedAt: now,
    sourceFileName: file.name,
    rows: importRows,
  };
  const impRes = await db.collection<RotationImport>("rotationImports").insertOne(importDoc);

  // Link generated users to this import for expiry management.
  const createdUserIds = importRows.filter((r) => r.generatedUserId).map((r) => toObjectId(r.generatedUserId!));
  if (createdUserIds.length) {
    await db.collection<User>("users").updateMany(
      { _id: { $in: createdUserIds } },
      { $set: { rotationImportId: impRes.insertedId } }
    );
  }

  await logAudit({
    collection: "rotationImports",
    documentId: impRes.insertedId,
    action: "create",
    summary: `Rotation import "${file.name}": ${created}/${rows.length} users created`,
    performedBy: adminId,
  });

  return Response.json(
    {
      total: rows.length,
      created,
      failed: rows.length - created,
      rows: importRows,
      importId: impRes.insertedId,
    },
    { status: created ? 201 : 200 }
  );
}
