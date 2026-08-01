import { requireRole, requireCapability, toObjectId, isValidObjectId } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import type { OperationForm } from "@/lib/models/types";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await requireCapability("complete-operation-form");
  if (!session) return Response.json({ error: "Requires the complete-operation-form capability" }, { status: 403 });
  const userId = toObjectId((session.user as any).id);

  const body = await req.json();
  const db = await getDb();
  if (!isValidObjectId(params.id)) return Response.json({ error: "Invalid operation form id" }, { status: 400 });
  const existing = await db.collection<OperationForm>("operationForms").findOne({ _id: toObjectId(params.id) });
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

  const update: Record<string, unknown> = { ...body };
  if (body.assistants) update.assistants = body.assistants.map(toObjectId);
  if (body.date) update.date = new Date(body.date);

  await db.collection<OperationForm>("operationForms").updateOne({ _id: existing._id }, { $set: update });

  await logAudit({
    collection: "operationForms",
    documentId: existing._id,
    action: "update",
    summary: `Updated operation form: ${Object.keys(body).join(", ")}`,
    performedBy: userId,
  });

  const updated = await db.collection<OperationForm>("operationForms").findOne({ _id: existing._id });
  return Response.json(updated);
}
