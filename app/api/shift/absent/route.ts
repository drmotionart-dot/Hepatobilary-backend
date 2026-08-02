import { requireCapability, toObjectId } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { handleRoute } from "@/lib/http";
import { markAbsent, clearAbsent } from "@/lib/services/shiftService";

// Mark/un-mark an assigned intern absent (spec 6.2). The user stays in the
// slot's userIds — the roster records "assigned but absent" — so removing them
// from the duty group is never conflated with marking them absent. Marking also
// mirrors a note ("absent — <reason>") into the attendance record, but never
// overwrites an explicitly-present attendance entry, and un-marking does not
// touch attendance.
export async function POST(req: Request) {
  const session = await requireCapability("manage-roster");
  if (!session) return Response.json({ error: "Requires the manage-roster capability" }, { status: 403 });
  const actingId = toObjectId((session.user as any).id);

  return handleRoute(async () => {
    const body = await req.json();
    const db = await getDb();
    const updated = await markAbsent(db, body, actingId);
    return Response.json(updated);
  });
}

export async function DELETE(req: Request) {
  const session = await requireCapability("manage-roster");
  if (!session) return Response.json({ error: "Requires the manage-roster capability" }, { status: 403 });
  const actingId = toObjectId((session.user as any).id);

  return handleRoute(async () => {
    const body = await req.json();
    const db = await getDb();
    const updated = await clearAbsent(db, body, actingId);
    return Response.json(updated);
  });
}
