import { requireRole } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { toObjectId } from "@/lib/api";
import type { LabTestNameMapping } from "@/lib/models/types";

export async function GET() {
  const session = await requireRole(["intern", "resident", "admin"]);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const db = await getDb();
  const mappings = await db.collection<LabTestNameMapping>("labTestNameMappings").find().toArray();
  return Response.json(mappings);
}

export async function POST(req: Request) {
  // Managing lab test name mappings is part of the resident panel (spec §7),
  // alongside admins.
  const session = await requireRole(["resident", "admin"]);
  if (!session) return Response.json({ error: "Resident or admin only" }, { status: 403 });
  const userId = toObjectId((session.user as any).id);

  const body = await req.json();
  const { externalTestName, internalTestKey, category } = body;
  if (!externalTestName || !internalTestKey) {
    return Response.json({ error: "externalTestName and internalTestKey are required" }, { status: 400 });
  }

  const db = await getDb();
  const doc: LabTestNameMapping = { externalTestName, internalTestKey, category: category || "Others" };
  const res = await db.collection<LabTestNameMapping>("labTestNameMappings").insertOne(doc);

  await logAudit({
    collection: "labTestNameMappings",
    documentId: res.insertedId,
    action: "create",
    summary: `Added mapping ${externalTestName} → ${internalTestKey}`,
    performedBy: userId,
  });

  return Response.json({ ...doc, _id: res.insertedId }, { status: 201 });
}
