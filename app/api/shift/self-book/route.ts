import { requireRole } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { handleRoute } from "@/lib/http";
import { selfBook } from "@/lib/services/shiftService";

// Intern self-booking (spec 6.1: "free-for-all booking" — interns claim open
// slots within the 8-week roster window). Server enforces that a user can only
// toggle THEMSELVES, only on intern slots, only within [today, today + 56d],
// and on at most one slot per day. Everything is audit-logged (spec 7.1).
export async function POST(req: Request) {
  const session = await requireRole(["intern"]);
  if (!session) return Response.json({ error: "Interns only" }, { status: 403 });

  return handleRoute(req, async () => {
    const body = await req.json();
    const db = await getDb();
    const { doc, status } = await selfBook(db, body, session.user);
    return Response.json(doc, { status });
  });
}
