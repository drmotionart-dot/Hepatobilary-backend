import { requireSession } from "@/lib/api";
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
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const userId = toObjectId((session.user as any).id);

  const body = await req.json();
  const { encounterId, context, presentingLine, pmhx, pshx, complaint, generalExam, localExam, riskFactors, investigationsOrdered, recommendation, treatmentOrders } = body;

  if (!encounterId || !context) {
    return Response.json({ error: "encounterId and context are required" }, { status: 400 });
  }

  const db = await getDb();
  const now = new Date();
  const doc: ClinicalNote = {
    encounterId: toObjectId(encounterId),
    context,
    authoredBy: userId,
    presentingLine: presentingLine || "",
    pmhx: pmhx || [],
    pshx: pshx || [],
    complaint: complaint || { main: "", duration: "", associated: [], pertinentNegatives: [], bowelHabit: "normal", dysuria: false, viralHepatitis: { hcv: false, hbv: false, hiv: false } },
    generalExam: generalExam || { consciousness: "A", bp: "", hr: 0, ecgRequired: false, ecgDone: false, echoRequired: false, echoDone: false },
    localExam: localExam || { templateUsed: "generic", fields: {} },
    riskFactors: riskFactors || {},
    investigationsOrdered: investigationsOrdered || [],
    recommendation: recommendation || "",
    treatmentOrders: treatmentOrders || [],
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
