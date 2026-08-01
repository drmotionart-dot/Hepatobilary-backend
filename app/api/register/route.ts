import { getDb } from "@/lib/mongodb";
import bcrypt from "bcryptjs";
import type { User } from "@/lib/models/types";
import { normalizePhone } from "@/lib/roster-import";
import { logAudit } from "@/lib/audit";

// Self-registration (spec 10.1): accounts land in pending-approval and stay
// there until an admin approves them. They never expire. The loginId is the
// email they register with (spec 3.1); an optional phone is kept on the
// account so roster imports can match them later (spec 6.1/10.2).
export async function POST(req: Request) {
  const body = await req.json();
  const { fullName, email, password, role, phone } = body;
  if (!fullName || !email || !password) {
    return Response.json({ error: "fullName, email and password are required" }, { status: 400 });
  }
  if (String(password).length < 8) {
    return Response.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  }
  if (!["intern", "resident"].includes(role)) {
    return Response.json({ error: "role must be intern or resident" }, { status: 400 });
  }

  const db = await getDb();
  const loginId = email.toLowerCase();
  const normalizedPhone = phone ? normalizePhone(String(phone)) : "";

  const existing =
    (await db.collection<User>("users").findOne({ loginId })) ||
    (normalizedPhone ? await db.collection<User>("users").findOne({ phone: normalizedPhone }) : null);
  if (existing) return Response.json({ error: "Account already registered" }, { status: 409 });

  const now = new Date();
  const user: User = {
    fullName,
    role,
    loginId,
    email: loginId,
    ...(normalizedPhone ? { phone: normalizedPhone } : {}),
    passwordHash: await bcrypt.hash(password, 10),
    accountType: "self-registered",
    status: "pending-approval",
    approvedBy: null,
    approvedAt: null,
    mustChangePassword: false,
    expiresAt: null,
    rotationImportId: null,
    createdAt: now,
    updatedAt: now,
  };
  const res = await db.collection<User>("users").insertOne(user);

  await logAudit({
    collection: "users",
    documentId: res.insertedId,
    action: "create",
    summary: `Self-registration submitted for ${fullName} (${loginId}, ${role}) — pending approval`,
    performedBy: res.insertedId,
  });

  return Response.json(
    { ok: true, message: "Registration submitted. An admin must approve your account before you can log in." },
    { status: 201 }
  );
}
