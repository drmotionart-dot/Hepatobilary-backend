import { requireSession, toObjectId } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import type { User } from "@/lib/models/types";

// GET /api/auth/me — returns the currently authenticated user (used to
// re-validate a token client-side without re-logging in). The user is read
// fresh from the DB so capability grants take effect immediately (spec 11.7).
export async function GET() {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const db = await getDb();
  const user = await db.collection<User>("users").findOne(
    { _id: toObjectId(session.user.id) },
    { projection: { fullName: 1, role: 1, email: 1, phone: 1, status: 1, grantedCapabilities: 1, mustChangePassword: 1, tourCompletedAt: 1 } }
  );
  if (!user) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({
    user: { ...session.user, grantedCapabilities: user.grantedCapabilities ?? [], tourCompletedAt: user.tourCompletedAt ?? null },
  });
}
