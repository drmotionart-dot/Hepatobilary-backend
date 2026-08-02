import { requireRole, requireCapability, toObjectId } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { handleRoute } from "@/lib/http";
import { listAssignments, setAssignment, bulkGenerate } from "@/lib/services/shiftService";

export async function GET(req: Request) {
  const session = await requireRole(["intern", "resident", "admin"]);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  return handleRoute(req, async () => {
    const url = new URL(req.url);
    const date = url.searchParams.get("date");
    const db = await getDb();
    const result = await listAssignments(db, date);
    return Response.json(result);
  });
}

// Assign one or more users to a slot, generate a date range's slots from the
// day-type calendar, or both. POST body shapes:
//   { date, roleSlotDefinitionId, userIds: string[] }  -> replace the group
//   { date, roleSlotDefinitionId, userId: string }     -> toggle one user in/out
//   { from, to }                                       -> bulk generate
export async function POST(req: Request) {
  const session = await requireCapability("manage-roster");
  if (!session) return Response.json({ error: "Requires the manage-roster capability" }, { status: 403 });
  const userId = toObjectId((session.user as any).id);

  return handleRoute(req, async () => {
    const body = await req.json();
    const db = await getDb();

    if (body.from && body.to) {
      const result = await bulkGenerate(db, body.from, body.to, userId);
      return Response.json(result);
    }

    const { doc, status } = await setAssignment(db, body, userId);
    return Response.json(doc, { status });
  });
}
