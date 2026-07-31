import { requireSession } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { toObjectId } from "@/lib/api";
import type { LabPanel } from "@/lib/models/types";

export async function GET(req: Request) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const encounterId = url.searchParams.get("encounterId");
  const db = await getDb();

  if (!encounterId) {
    const panels = await db.collection<LabPanel>("labPanels").find().sort({ createdAt: -1 }).toArray();
    return Response.json(panels);
  }

  const panel = await db.collection<LabPanel>("labPanels").findOne({ encounterId: toObjectId(encounterId) });
  return Response.json(panel || null);
}

export async function POST(req: Request) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const userId = toObjectId((session.user as any).id);

  const body = await req.json();
  const { encounterId, date, category, test, value } = body;
  if (!encounterId || !test) {
    return Response.json({ error: "encounterId and test are required" }, { status: 400 });
  }

  const db = await getDb();
  const entry = { date: date ? new Date(date) : new Date(), category: category || "Others", test, value: value || "" };
  const existing = await db.collection<LabPanel>("labPanels").findOne({ encounterId: toObjectId(encounterId) });

  if (existing) {
    const already = (existing.results || []).some(
      (r) => r.test === test && new Date(r.date).toDateString() === entry.date.toDateString()
    );
    if (already) {
      return Response.json({ error: "Test already recorded for this date" }, { status: 409 });
    }
    await db.collection<LabPanel>("labPanels").updateOne(
      { _id: existing._id },
      { $push: { results: entry } }
    );
    await logAudit({
      collection: "labPanels",
      documentId: existing._id,
      action: "update",
      summary: `Added lab result ${test} (${entry.value})`,
      performedBy: userId,
    });
    const updated = await db.collection<LabPanel>("labPanels").findOne({ _id: existing._id });
    return Response.json(updated);
  }

  const doc: LabPanel = { encounterId: toObjectId(encounterId), results: [entry] };
  const res = await db.collection<LabPanel>("labPanels").insertOne(doc);
  await logAudit({
    collection: "labPanels",
    documentId: res.insertedId,
    action: "create",
    summary: `Created lab panel for encounter ${encounterId}`,
    performedBy: userId,
  });
  return Response.json({ ...doc, _id: res.insertedId }, { status: 201 });
}
