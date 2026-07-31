import { requireRole } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { toObjectId } from "@/lib/api";
import type { CaseTypeTemplate } from "@/lib/models/types";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await requireRole(["admin"]);
  if (!session) return Response.json({ error: "Admin only" }, { status: 403 });
  const userId = toObjectId((session.user as any).id);

  const body = await req.json();
  const db = await getDb();
  const existing = await db.collection<CaseTypeTemplate>("caseTypeTemplates").findOne({ _id: toObjectId(params.id) });
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

  await db.collection<CaseTypeTemplate>("caseTypeTemplates").updateOne(
    { _id: existing._id },
    { $set: body }
  );

  await logAudit({
    collection: "caseTypeTemplates",
    documentId: existing._id,
    action: "update",
    summary: `Updated template "${existing.name}"`,
    performedBy: userId,
  });

  const updated = await db.collection<CaseTypeTemplate>("caseTypeTemplates").findOne({ _id: existing._id });
  return Response.json(updated);
}
