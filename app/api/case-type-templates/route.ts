import { requireRole } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { toObjectId } from "@/lib/api";
import type { CaseTypeTemplate } from "@/lib/models/types";

export async function GET() {
  const session = await requireRole(["intern", "resident", "admin"]);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const db = await getDb();
  const templates = await db.collection<CaseTypeTemplate>("caseTypeTemplates").find().toArray();
  return Response.json(templates);
}

export async function POST(req: Request) {
  const session = await requireRole(["admin"]);
  if (!session) return Response.json({ error: "Admin only" }, { status: 403 });
  const userId = toObjectId((session.user as any).id);

  const body = await req.json();
  const { name, leChecklist, riskFactorChecklist, labPanelPreset, dietInstruction } = body;
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });

  const db = await getDb();
  const doc: CaseTypeTemplate = {
    name,
    leChecklist: leChecklist || [],
    riskFactorChecklist: riskFactorChecklist || [],
    labPanelPreset: labPanelPreset || [],
    dietInstruction: dietInstruction || "",
    active: body.active ?? true,
  };
  const res = await db.collection<CaseTypeTemplate>("caseTypeTemplates").insertOne(doc);

  await logAudit({
    collection: "caseTypeTemplates",
    documentId: res.insertedId,
    action: "create",
    summary: `Created case type template "${name}"`,
    performedBy: userId,
  });

  return Response.json({ ...doc, _id: res.insertedId }, { status: 201 });
}
