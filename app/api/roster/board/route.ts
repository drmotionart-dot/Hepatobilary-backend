import { requireSession } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { handleRoute } from "@/lib/http";
import { getBoard } from "@/lib/services/rosterService";

// The 8-week roster board in one call: active users, the slot rulebook, the
// existing assignments, the day-type calendar, and the emergency-duty pools
// (spec 6.1) over the same window.
export async function GET() {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  return handleRoute(async () => {
    const db = await getDb();
    const board = await getBoard(db);
    return Response.json(board);
  });
}
