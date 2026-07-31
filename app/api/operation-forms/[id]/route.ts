import { requireRole } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { toObjectId } from "@/lib/api";
import type { OperationForm } from "@/lib/models/types";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await requireRole(["resident", "admin"]);
  if (!session) return Response.json({ error: "Resident or admin only" }, { status: 403 });
  const userId = toObjectId((session.user as any).id);

  const body = await req.json();
  const db = await getDb();
  const existing = await db.collection<OperationForm>("operationForms").findOne({ _id: toObjectId(params.id) });
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

  const update: Record<string, unknown> = { ...body };
  if (body.assistants) update.assistants = body.assistants.map(toObjectId);

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
