import { requireSession } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { toObjectId } from "@/lib/api";
import type { ImagingRequest } from "@/lib/models/types";

export async function GET(req: Request) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const encounterId = url.searchParams.get("encounterId");
  const db = await getDb();

  const filter = encounterId ? { encounterId: toObjectId(encounterId) } : {};
  const requests = await db.collection<ImagingRequest>("imagingRequests").find(filter).sort({ requestedAt: -1 }).toArray();
  return Response.json(requests);
}

export async function POST(req: Request) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const userId = toObjectId((session.user as any).id);

  const body = await req.json();
  const { encounterId, modality, modalityDetail, clinicalDiagnosis, pertinentClinicalData, partToBeExamined, aimOfExamination } = body;
  if (!encounterId || !modality || !partToBeExamined) {
    return Response.json({ error: "encounterId, modality and partToBeExamined are required" }, { status: 400 });
  }

  const db = await getDb();
  const doc: ImagingRequest = {
    encounterId: toObjectId(encounterId),
    modality,
    modalityDetail: modalityDetail || "",
    clinicalDiagnosis: clinicalDiagnosis || "",
    pertinentClinicalData: pertinentClinicalData || "",
    partToBeExamined,
    aimOfExamination: aimOfExamination || "",
    requestedBy: userId,
    requestedAt: new Date(),
    status: "requested",
    appointment: null,
    result: null,
    resultAttachedAt: null,
  };
  const res = await db.collection<ImagingRequest>("imagingRequests").insertOne(doc);

  await logAudit({
    collection: "imagingRequests",
    documentId: res.insertedId,
    action: "create",
    summary: `Requested ${modality} (${partToBeExamined})`,
    performedBy: userId,
  });

  return Response.json({ ...doc, _id: res.insertedId }, { status: 201 });
}
