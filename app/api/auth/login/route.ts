import bcrypt from "bcryptjs";
import { getDb } from "@/lib/mongodb";
import { signToken } from "@/lib/jwt";
import { requireSession } from "@/lib/api";
import type { User } from "@/lib/models/types";

// POST /api/auth/login — verifies credentials and returns a signed JWT plus
// the user's role. The frontend stores the token and sends it as
// `Authorization: Bearer <token>` on every protected request (spec §2.1).
// Account lifecycle rules from spec §10 are enforced here: pending/removed
// accounts can't log in, and expired bulk-generated accounts (50 days) are
// cut off automatically.
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body) return Response.json({ error: "Invalid request body" }, { status: 400 });

  // The login credential is the user's loginId (spec 3.1): an email for
  // self-registered accounts, a generated ID (e.g. hpb01123456789) for
  // bulk-generated ones. Both are stored lowercase, so match case-insensitively.
  const loginId = String(body.loginId || body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!loginId || !password) {
    return Response.json({ error: "Login ID and password are required" }, { status: 400 });
  }

  const db = await getDb();
  const user = await db.collection<User>("users").findOne({ loginId });
  if (!user || !user.passwordHash) {
    return Response.json({ error: "Invalid login ID or password" }, { status: 401 });
  }

  if (user.status === "pending-approval") {
    return Response.json({ error: "Account pending approval" }, { status: 403 });
  }
  if (user.status === "removed") {
    return Response.json({ error: "Account has been removed" }, { status: 403 });
  }
  if (user.status === "expired" || (user.expiresAt && user.expiresAt < new Date())) {
    if (user.status !== "expired") {
      await db.collection<User>("users").updateOne({ _id: user._id }, { $set: { status: "expired" } });
    }
    return Response.json({ error: "Account has expired" }, { status: 403 });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return Response.json({ error: "Invalid login ID or password" }, { status: 401 });

  const id = user._id!.toString();
  const token = await signToken({
    sub: id,
    role: user.role,
    name: user.fullName,
    email: user.email ?? undefined,
    mustChangePassword: user.mustChangePassword,
  });

  return Response.json({
    token,
    user: {
      id,
      role: user.role,
      name: user.fullName,
      email: user.email,
      mustChangePassword: user.mustChangePassword,
    },
  });
}

// GET /api/auth/me — returns the currently authenticated user (used to
// re-validate a token client-side without re-logging in).
export async function GET() {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json({ user: session.user });
}
