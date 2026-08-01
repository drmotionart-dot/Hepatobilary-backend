import { requireSession, requireRole } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { toObjectId } from "@/lib/api";
import type { ClinicalNote } from "@/lib/models/types";

export async function GET(req: Request) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const encounterId = url.searchParams.get("encounterId");
  const db = await getDb();

  const filter = encounterId ? { encounterId: toObjectId(encounterId) } : {};
  const notes = await db
    .collection<ClinicalNote>("clinicalNotes")
    .find(filter)
    .sort({ createdAt: -1 })
    .toArray();

  return Response.json(notes);
}

export async function POST(req: Request) {
  // Writing clinical notes is intern/resident only — admin reads but doesn't write (spec §7).
  const session = await requireRole(["intern", "resident"]);
  if (!session) return Response.json({ error: "Intern or resident only" }, { status: 403 });
  const userId = toObjectId((session.user as any).id);

  const body = await req.json();
  const { encounterId, context, presentingLine, pmhx, pshx, complaint, generalExam, localExam, riskFactors, investigationsOrdered, recommendation, treatmentOrders } = body;

  if (!encounterId || !context) {
    return Response.json({ error: "encounterId and context are required" }, { status: 400 });
  }

  const db = await getDb();
  const now = new Date();

  // Spec §5 universal rules — enforced server-side as a safety net even if the
  // client didn't apply them: age > 40 → ECG required, age > 60 → Echo required,
  // smoker → auto-add Atrovent + Pulmicort to orders.
  const encounter = await db.collection("encounters").findOne({ _id: toObjectId(encounterId) });
  let patientAge = 0;
  if (encounter?.patientId) {
    const patient = await db.collection("patients").findOne({ _id: encounter.patientId });
    patientAge = (patient as any)?.age ?? 0;
  }
  const riskFactorsIn = riskFactors || {};
  const smoker = Boolean(riskFactorsIn.smoker);
  const treatmentOrdersIn = (treatmentOrders || []) as string[];
  const seenOrders = new Set(treatmentOrdersIn.map((o) => String(o).trim().toLowerCase()));
  const extraOrders = ["Atrovent", "Pulmicort"].filter((m) => !seenOrders.has(m.toLowerCase()));
  const orders = smoker && extraOrders.length ? [...treatmentOrdersIn, ...extraOrders] : treatmentOrdersIn;

  const generalExamIn = (generalExam || {}) as any;
  const generalExamDoc = {
    consciousness: "A",
    bp: "",
    hr: 0,
    ecgRequired: false,
    ecgDone: false,
    echoRequired: false,
    echoDone: false,
    ...generalExamIn,
  };
  generalExamDoc.ecgRequired = patientAge > 40 || Boolean(generalExamIn.ecgRequired);
  generalExamDoc.echoRequired = patientAge > 60 || Boolean(generalExamIn.echoRequired);

  const doc: ClinicalNote = {
    encounterId: toObjectId(encounterId),
    context,
    authoredBy: userId,
    presentingLine: presentingLine || "",
    pmhx: pmhx || [],
    pshx: pshx || [],
    complaint: complaint || { main: "", duration: "", associated: [], pertinentNegatives: [], bowelHabit: "normal", dysuria: false, viralHepatitis: { hcv: false, hbv: false, hiv: false } },
    generalExam: generalExamDoc as ClinicalNote["generalExam"],
    localExam: localExam || { templateUsed: "generic", fields: {} },
    riskFactors: { ...riskFactorsIn, smoker },
    investigationsOrdered: investigationsOrdered || [],
    recommendation: recommendation || "",
    treatmentOrders: orders,
    createdAt: now,
  };
  const res = await db.collection<ClinicalNote>("clinicalNotes").insertOne(doc);

  await logAudit({
    collection: "clinicalNotes",
    documentId: res.insertedId,
    action: "create",
    summary: `Clinical note (${context}) on encounter ${encounterId}`,
    performedBy: userId,
  });

  return Response.json({ ...doc, _id: res.insertedId }, { status: 201 });
}
