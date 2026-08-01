import { requireSession } from "@/lib/api";
import { resolveDayType } from "@/lib/day-type";

// GET /api/day-type-calendar/resolve?date=YYYY-MM-DD — the resolved day type for
// a local calendar date: stored DayTypeCalendar wins, otherwise weekday defaults
// (Thu → clinic, Sun/Wed → normal+surgeryOverlay, else normal). Any authenticated
// user (interns need it for the self-book UI; residents for bulk-generate previews).
export async function GET(req: Request) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const dateParam = url.searchParams.get("date");
  if (!dateParam) return Response.json({ error: "date is required (YYYY-MM-DD)" }, { status: 400 });

  const date = new Date(`${dateParam}T00:00:00`);
  if (isNaN(date.getTime())) return Response.json({ error: "Invalid date" }, { status: 400 });

  const resolved = await resolveDayType(date);
  return Response.json(resolved);
}
