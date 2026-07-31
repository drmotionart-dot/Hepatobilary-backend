import { requireRole } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { toObjectId } from "@/lib/api";
import type { DischargeForm } from "@/lib/models/types";

export async function GET(req: Request) {
  const session = await requireRole(["intern", "resident", "admin"]);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const encounterId = url.searchParams.get("encounterId");
  const db = await getDb();

  if (encounterId) {
    const form = await db.collection<DischargeForm>("dischargeForms").findOne({ encounterId: toObjectId(encounterId) });
    return Response.json(form || null);
  }
  const forms = await db.collection<DischargeForm>("dischargeForms").find().sort({ dischargeDate: -1 }).toArray();
  return Response.json(forms);
}

export async function POST(req: Request) {
  const session = await requireRole(["resident", "admin"]);
  if (!session) return Response.json({ error: "Resident or admin only" }, { status: 403 });
  const userId = toObjectId((session.user as any).id);

  const body = await req.json();
  const { encounterId, summary } = body;
  if (!encounterId || !summary) {
    return Response.json({ error: "encounterId and summary are required" }, { status: 400 });
  }

  const db = await getDb();
  const doc: DischargeForm = {
    encounterId: toObjectId(encounterId),
    dischargeDate: body.dischargeDate ? new Date(body.dischargeDate) : new Date(),
    summary,
    followUpRequired: body.followUpRequired ?? false,
    followUpInstructions: body.followUpInstructions || null,
    dischargedBy: userId,
  };
  const res = await db.collection<DischargeForm>("dischargeForms").insertOne(doc);

  await logAudit({
    collection: "dischargeForms",
    documentId: res.insertedId,
    action: "create",
    summary: `Discharge form for encounter ${encounterId}`,
    performedBy: userId,
  });

  return Response.json({ ...doc, _id: res.insertedId }, { status: 201 });
}
