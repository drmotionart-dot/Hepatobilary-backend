import { requireRole, requireCapability, toObjectId } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { handleRoute } from "@/lib/http";
import { listDayTypes, setDayType } from "@/lib/services/dayTypeService";

export async function GET(req: Request) {
  const session = await requireRole(["intern", "resident", "admin"]);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  return handleRoute(req, async () => {
    const url = new URL(req.url);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const db = await getDb();
    const days = await listDayTypes(db, from, to);
    return Response.json(days);
  });
}

export async function POST(req: Request) {
  const session = await requireCapability("set-day-type-calendar");
  if (!session) return Response.json({ error: "Requires the set-day-type-calendar capability" }, { status: 403 });
  const userId = toObjectId((session.user as any).id);

  return handleRoute(req, async () => {
    const body = await req.json();
    const db = await getDb();
    const { doc, status } = await setDayType(db, body, userId);
    return Response.json(doc, { status });
  });
}
