import { requireSession } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { toObjectId } from "@/lib/api";
import bcrypt from "bcryptjs";
import { signToken } from "@/lib/jwt";
import type { User } from "@/lib/models/types";

// Password change — required on first login for bulk-generated accounts
// (spec 10.3), also clears the mustChangePassword flag.
export async function POST(req: Request) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const userId = toObjectId((session.user as any).id);

  const body = await req.json();
  const { currentPassword, newPassword } = body;
  if (!currentPassword || !newPassword) {
    return Response.json({ error: "currentPassword and newPassword are required" }, { status: 400 });
  }
  if (newPassword.length < 8) {
    return Response.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  }

  const db = await getDb();
  const user = await db.collection<User>("users").findOne({ _id: userId });
  if (!user) return Response.json({ error: "User not found" }, { status: 404 });

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) return Response.json({ error: "Current password is incorrect" }, { status: 400 });

  await db.collection<User>("users").updateOne(
    { _id: user._id },
    { $set: { passwordHash: await bcrypt.hash(newPassword, 10), mustChangePassword: false, updatedAt: new Date() } }
  );

  await logAudit({
    collection: "users",
    documentId: user._id,
    action: "update",
    summary: `Password changed for ${user.loginId}`,
    performedBy: userId,
  });

  // Issue a fresh token so the frontend can drop the stale
  // mustChangePassword flag immediately without re-logging in.
  const token = await signToken({
    sub: user._id!.toString(),
    role: user.role,
    name: user.fullName,
    email: user.email ?? undefined,
    mustChangePassword: false,
  });

  return Response.json({ ok: true, token });
}
