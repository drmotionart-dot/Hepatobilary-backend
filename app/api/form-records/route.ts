import { requireRole, toObjectId, isValidObjectId } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import type { FormRecord } from "@/lib/models/types";

export async function GET(req: Request) {
  const session = await requireRole(["intern", "resident", "admin"]);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const encounterId = url.searchParams.get("encounterId");
  const db = await getDb();

  if (encounterId && !isValidObjectId(encounterId)) {
    return Response.json({ error: "Invalid encounterId" }, { status: 400 });
  }
  const filter = encounterId ? { encounterId: toObjectId(encounterId) } : {};
  const records = await db.collection<FormRecord>("formRecords").find(filter).sort({ createdAt: -1 }).toArray();

  const userIds = [...new Set(records.map((r) => r.createdBy.toString()))];
  const users = await db
    .collection("users")
    .find({ _id: { $in: userIds.map(toObjectId) } })
    .project({ fullName: 1 })
    .toArray();
  const userMap = new Map(users.map((u: any) => [u._id.toString(), u.fullName]));

  return Response.json(
    records.map((r) => ({ ...r, authorName: userMap.get(r.createdBy.toString()) || "Unknown" }))
  );
}

export async function POST(req: Request) {
  // Filling case-type forms is intern/resident only (spec §7).
  const session = await requireRole(["intern", "resident"]);
  if (!session) return Response.json({ error: "Intern or resident only" }, { status: 403 });
  const userId = toObjectId((session.user as any).id);

  const body = await req.json();
  const { encounterId, templateId, values } = body;
  if (!encounterId || !templateId || !values) {
    return Response.json({ error: "encounterId, templateId and values are required" }, { status: 400 });
  }
  if (!isValidObjectId(encounterId) || !isValidObjectId(templateId)) {
    return Response.json({ error: "Invalid encounterId or templateId" }, { status: 400 });
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
