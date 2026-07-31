import { requireSession } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { toObjectId } from "@/lib/api";
import type { FormRecord } from "@/lib/models/types";

export async function GET(req: Request) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const encounterId = url.searchParams.get("encounterId");
  const db = await getDb();

  const filter = encounterId ? { encounterId: toObjectId(encounterId) } : {};
  const records = await db.collection<FormRecord>("formRecords").find(filter).sort({ createdAt: -1 }).toArray();
  return Response.json(records);
}

export async function POST(req: Request) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const userId = toObjectId((session.user as any).id);

  const body = await req.json();
  const { encounterId, templateId, values } = body;
  if (!encounterId || !templateId || !values) {
    return Response.json({ error: "encounterId, templateId and values are required" }, { status: 400 });
  }

  const db = await getDb();
  const doc: FormRecord = {
    encounterId: toObjectId(encounterId),
    templateId: toObjectId(templateId),
    values,
    createdBy: userId,
    createdAt: new Date(),
  };
  const res = await db.collection<FormRecord>("formRecords").insertOne(doc);

  await logAudit({
    collection: "formRecords",
    documentId: res.insertedId,
    action: "create",
    summary: `Filled form template ${templateId} for encounter ${encounterId}`,
    performedBy: userId,
  });

  return Response.json({ ...doc, _id: res.insertedId }, { status: 201 });
}
