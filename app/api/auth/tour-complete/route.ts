import { requireSession, toObjectId } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import type { User } from "@/lib/models/types";

// POST /api/auth/tour-complete — records that the signed-in user finished (or
// skipped) the onboarding tour, so it never auto-opens again (spec 14.3).
export async function POST() {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const db = await getDb();
  const now = new Date();
  await db.collection<User>("users").updateOne(
    { _id: toObjectId(session.user.id) },
    { $set: { tourCompletedAt: now, updatedAt: now } }
  );

  return Response.json({ ok: true, tourCompletedAt: now });
}
