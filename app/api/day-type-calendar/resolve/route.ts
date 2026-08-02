import { requireSession } from "@/lib/api";
import { handleRoute } from "@/lib/http";
import { resolveDayTypeForDate } from "@/lib/services/dayTypeService";

// GET /api/day-type-calendar/resolve?date=YYYY-MM-DD — the resolved day type for
// a local calendar date: stored DayTypeCalendar wins, otherwise weekday defaults
// (Thu → clinic, Sun/Wed → normal+surgeryOverlay, else normal). Any authenticated
// user (interns need it for the self-book UI; residents for bulk-generate previews).
export async function GET(req: Request) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  return handleRoute(async () => {
    const url = new URL(req.url);
    const dateParam = url.searchParams.get("date");
    const resolved = await resolveDayTypeForDate(dateParam);
    return Response.json(resolved);
  });
}
