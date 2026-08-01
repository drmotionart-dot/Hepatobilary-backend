import { requireRole, toObjectId, isValidObjectId } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { requireShiftKeyForIntern } from "@/lib/shift-key";
import type { ImagingRequest } from "@/lib/models/types";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await requireRole(["intern", "resident", "admin"]);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const userId = toObjectId((session.user as any).id);

  const gate = await requireShiftKeyForIntern(req, session);
  if (!gate.allowed) return Response.json({ error: gate.message, code: gate.code }, { status: gate.status });

  const body = await req.json();
  const db = await getDb();
  if (!isValidObjectId(params.id)) return Response.json({ error: "Invalid imaging request id" }, { status: 400 });
  const existing = await db.collection<ImagingRequest>("imagingRequests").findOne({ _id: toObjectId(params.id) });
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

  const update: Record<string, unknown> = { ...body };
  if (body.status === "resulted" && body.result) {
    update.resultAttachedAt = new Date();
  }

  await db.collection<ImagingRequest>("imagingRequests").updateOne({ _id: existing._id }, { $set: update });

  await logAudit({
    collection: "imagingRequests",
    documentId: existing._id,
    action: "update",
    summary: `Updated imaging request: ${Object.keys(body).join(", ")}`,
    performedBy: userId,
    shiftKey: gate.shiftKey,
    shiftKeyMatched: gate.shiftKeyMatched,
  });

  const updated = await db.collection<ImagingRequest>("imagingRequests").findOne({ _id: existing._id });
  return Response.json(updated);
}
