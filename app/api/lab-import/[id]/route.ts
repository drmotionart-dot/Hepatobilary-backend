import { requireRole, toObjectId, isValidObjectId } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import type { LabImport } from "@/lib/models/types";

// Remove a lab import from the review queue entirely (e.g. a mistakenly
// uploaded or duplicate PDF). Audit-logged so the removal is attributable.
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const session = await requireRole(["resident", "admin"]);
  if (!session) return Response.json({ error: "Resident or admin only" }, { status: 403 });
  const userId = toObjectId((session.user as any).id);

  const db = await getDb();
  if (!isValidObjectId(params.id)) return Response.json({ error: "Invalid import id" }, { status: 400 });
  const labImport = await db.collection<LabImport>("labImports").findOne({ _id: toObjectId(params.id) });
  if (!labImport) return Response.json({ error: "Import not found" }, { status: 404 });

  await db.collection<LabImport>("labImports").deleteOne({ _id: labImport._id });

  await logAudit({
    collection: "labImports",
    documentId: labImport._id,
    action: "delete",
    summary: `Removed lab import ${labImport.sourceFileName} (${labImport.patientCode})`,
    performedBy: userId,
  });

  return Response.json({ ok: true });
}
