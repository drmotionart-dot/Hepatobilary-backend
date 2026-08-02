import { requireCapability, toObjectId } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { handleRoute } from "@/lib/http";
import { processRosterImport } from "@/lib/services/rosterService";

// POST /api/roster/import — upload a Wardyati rotation .xlsx (one row per day,
// one column per shift slot, cells = bulleted "name + phone" entries). Matches
// people by phone (primary) or name (fallback), then fills the matching
// ShiftAssignment slots / EmergencyDayPools for each date (spec 6.1).
export async function POST(req: Request) {
  const session = await requireCapability("manage-roster");
  if (!session) return Response.json({ error: "Requires the manage-roster capability" }, { status: 403 });
  const importerId = toObjectId((session.user as any).id);

  return handleRoute(req, async () => {
    const formData = await req.formData();
    const file = formData.get("file") as File;
    if (!file) return Response.json({ error: "No file provided" }, { status: 400 });

    const XLSX = await import("xlsx");
    const buffer = Buffer.from(await file.arrayBuffer());
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });

    const db = await getDb();
    const result = await processRosterImport(db, file.name, aoa, importerId);
    return Response.json(result);
  });
}
