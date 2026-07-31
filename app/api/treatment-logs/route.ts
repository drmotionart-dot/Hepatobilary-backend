import { requireSession } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { toObjectId } from "@/lib/api";
import type { TreatmentLog } from "@/lib/models/types";

export async function GET(req: Request) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const encounterId = url.searchParams.get("encounterId");
  const db = await getDb();

  if (encounterId) {
    const log = await db.collection<TreatmentLog>("treatmentLogs").findOne({ encounterId: toObjectId(encounterId) });
    return Response.json(log || null);
  }
  const logs = await db.collection<TreatmentLog>("treatmentLogs").find().sort({ createdAt: -1 }).toArray();
  return Response.json(logs);
}

export async function POST(req: Request) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const userId = toObjectId((session.user as any).id);

  const body = await req.json();
  const { encounterId, treatment, otherRecommendations, date } = body;
  if (!encounterId || !treatment) {
    return Response.json({ error: "encounterId and treatment are required" }, { status: 400 });
  }

  const db = await getDb();
  const entry = {
    date: date ? new Date(date) : new Date(),
    treatment,
    otherRecommendations: otherRecommendations || "",
    physician: userId,
  };
  const existing = await db.collection<TreatmentLog>("treatmentLogs").findOne({ encounterId: toObjectId(encounterId) });

  if (existing) {
    await db.collection<TreatmentLog>("treatmentLogs").updateOne(
      { _id: existing._id },
      { $push: { entries: entry } }
    );
    await logAudit({
      collection: "treatmentLogs",
      documentId: existing._id,
      action: "update",
      summary: `Logged treatment: ${treatment}`,
      performedBy: userId,
    });
    const updated = await db.collection<TreatmentLog>("treatmentLogs").findOne({ _id: existing._id });
    return Response.json(updated);
  }

  const doc: TreatmentLog = { encounterId: toObjectId(encounterId), entries: [entry] };
  const res = await db.collection<TreatmentLog>("treatmentLogs").insertOne(doc);
  await logAudit({
    collection: "treatmentLogs",
    documentId: res.insertedId,
    action: "create",
    summary: `Started treatment log for encounter ${encounterId}`,
    performedBy: userId,
  });
  return Response.json({ ...doc, _id: res.insertedId }, { status: 201 });
}
