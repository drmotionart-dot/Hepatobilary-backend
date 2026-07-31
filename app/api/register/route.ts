import { getDb } from "@/lib/mongodb";
import bcrypt from "bcryptjs";
import type { User } from "@/lib/models/types";

// Self-registration (spec 10.1): accounts land in pending-approval and stay
// there until an admin approves them. They never expire.
export async function POST(req: Request) {
  const body = await req.json();
  const { fullName, email, password, role } = body;
  if (!fullName || !email || !password) {
    return Response.json({ error: "fullName, email and password are required" }, { status: 400 });
  }
  if (!["intern", "resident"].includes(role)) {
    return Response.json({ error: "role must be intern or resident" }, { status: 400 });
  }

  const db = await getDb();
  const existing = await db.collection<User>("users").findOne({ email: email.toLowerCase() });
  if (existing) return Response.json({ error: "Email already registered" }, { status: 409 });

  const now = new Date();
  const user: User = {
    fullName,
    role,
    email: email.toLowerCase(),
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
  await db.collection<User>("users").insertOne(user);

  return Response.json(
    { ok: true, message: "Registration submitted. An admin must approve your account before you can log in." },
    { status: 201 }
  );
}
