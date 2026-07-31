import { requireSession } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { toObjectId } from "@/lib/api";
import type { Encounter, Patient } from "@/lib/models/types";

export async function GET(req: Request) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const type = url.searchParams.get("type");
  const status = url.searchParams.get("status");
  const ward = url.searchParams.get("ward");
  const patientId = url.searchParams.get("patientId");

  const db = await getDb();
  const filter: Record<string, unknown> = {};
  if (type && ["emergency", "ward", "clinic"].includes(type)) filter.type = type;
  if (status) filter.status = status;
  if (ward && ["male", "female"].includes(ward)) filter.ward = ward;
  if (patientId) filter.patientId = toObjectId(patientId);

  const encounters = await db
    .collection<Encounter>("encounters")
    .find(filter)
    .sort({ openedAt: -1 })
    .toArray();

  const patientIds = [...new Set(encounters.map((e) => e.patientId.toString()))];
  const patients = await db
    .collection<Patient>("patients")
    .find({ _id: { $in: patientIds.map(toObjectId) } })
    .toArray();
  const patientMap = new Map(patients.map((p) => [p._id!.toString(), p]));

  return Response.json(
    encounters.map((e) => ({
      ...e,
      patient: patientMap.get(e.patientId.toString()) || null,
    }))
  );
}

export async function POST(req: Request) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const userId = toObjectId((session.user as any).id);

  const body = await req.json();
  const { patientId, type, caseType, ward, status } = body;
  if (!patientId || !type || !caseType) {
    return Response.json({ error: "patientId, type and caseType are required" }, { status: 400 });
  }

  const db = await getDb();
  const patient = await db.collection<Patient>("patients").findOne({ _id: toObjectId(patientId) });
  if (!patient) return Response.json({ error: "Patient not found" }, { status: 404 });

  const now = new Date();
  const doc: Encounter = {
    patientId: toObjectId(patientId),
    type,
    caseType,
    status: status || "active",
    ward: ward || null,
    openedAt: now,
    closedAt: null,
    openedBy: userId,
    linkedFollowUpOf: null,
  };
  const res = await db.collection<Encounter>("encounters").insertOne(doc);

  await logAudit({
    collection: "encounters",
    documentId: res.insertedId,
    action: "create",
    summary: `Opened ${type} encounter (${caseType}) for ${patient.fullName}`,
    performedBy: userId,
  });

  return Response.json({ ...doc, _id: res.insertedId }, { status: 201 });
}
