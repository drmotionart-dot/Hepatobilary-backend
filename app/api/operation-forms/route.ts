import { requireRole } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { toObjectId } from "@/lib/api";
import type { OperationForm } from "@/lib/models/types";

export async function GET(req: Request) {
  const session = await requireRole(["intern", "resident", "admin"]);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const encounterId = url.searchParams.get("encounterId");
  const db = await getDb();

  if (encounterId) {
    const form = await db.collection<OperationForm>("operationForms").findOne({ encounterId: toObjectId(encounterId) });
    return Response.json(form || null);
  }
  const forms = await db.collection<OperationForm>("operationForms").find().sort({ date: -1 }).toArray();
  return Response.json(forms);
}

export async function POST(req: Request) {
  const session = await requireRole(["resident", "admin"]);
  if (!session) return Response.json({ error: "Resident or admin only" }, { status: 403 });
  const userId = toObjectId((session.user as any).id);

  const body = await req.json();
  const { encounterId, patientNo, procedureName } = body;
  if (!encounterId || !procedureName) {
    return Response.json({ error: "encounterId and procedureName are required" }, { status: 400 });
  }

  const db = await getDb();
  const doc: OperationForm = {
    encounterId: toObjectId(encounterId),
    patientNo: patientNo || "",
    procedureName,
    preOpDiagnosis: body.preOpDiagnosis || "",
    postOpDiagnosis: body.postOpDiagnosis || "",
    surgeon: userId,
    assistants: (body.assistants || []).map(toObjectId),
    anesthesiaType: body.anesthesiaType || "",
    anesthetist: body.anesthetist || "",
    findings: body.findings || "",
    procedureDetails: body.procedureDetails || "",
    specimensSent: body.specimensSent || [],
    estimatedBloodLoss: body.estimatedBloodLoss || "",
    complications: body.complications || "",
    postOpPlan: body.postOpPlan || "",
    date: body.date ? new Date(body.date) : new Date(),
  };
  const res = await db.collection<OperationForm>("operationForms").insertOne(doc);

  await logAudit({
    collection: "operationForms",
    documentId: res.insertedId,
    action: "create",
    summary: `Operation form: ${procedureName}`,
    performedBy: userId,
  });

  return Response.json({ ...doc, _id: res.insertedId }, { status: 201 });
}
