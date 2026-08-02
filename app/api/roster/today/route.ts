import { requireSession } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { handleRoute } from "@/lib/http";
import { getToday } from "@/lib/services/rosterService";

// Who is on shift now (spec section 7): resolve the active shift's day type,
// then return the assignments for that day grouped by shift window. Uses the
// same 08:00 → 08:00 shift boundary as the dashboard, so before 08:00 "on
// shift now" means the previous calendar day.
export async function GET() {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  return handleRoute(async () => {
    const db = await getDb();
    const today = await getToday(db);
    return Response.json(today);
  });
}
