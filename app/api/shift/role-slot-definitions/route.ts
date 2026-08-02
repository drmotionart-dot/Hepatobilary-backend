import { requireSession } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { handleRoute } from "@/lib/http";
import { rosterRepo } from "@/lib/repositories/rosterRepo";

export async function GET() {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  return handleRoute(async () => {
    const db = await getDb();
    const slots = await rosterRepo.findRoleSlots(db);
    return Response.json(slots);
  });
}
