import { requireSession } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { toObjectId } from "@/lib/api";
import type { ImagingRequest } from "@/lib/models/types";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const userId = toObjectId((session.user as any).id);

  const body = await req.json();
  const db = await getDb();
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
  });

  const updated = await db.collection<ImagingRequest>("imagingRequests").findOne({ _id: existing._id });
  return Response.json(updated);
}
