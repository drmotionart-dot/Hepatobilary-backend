import { requireSession, requireRole, toObjectId, isValidObjectId } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import type { WithId } from "mongodb";
import type { Encounter, Patient, ClinicalNote, LabPanel, ImagingRequest, ReferralConsult, TreatmentLog, OperationForm, DischargeForm } from "@/lib/models/types";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isValidObjectId(params.id)) return Response.json({ error: "Invalid encounter id" }, { status: 400 });

  const db = await getDb();
  const encounter = await db.collection<Encounter>("encounters").findOne({ _id: toObjectId(params.id) });
  if (!encounter) return Response.json({ error: "Not found" }, { status: 404 });

  const patient = await db.collection<Patient>("patients").findOne({ _id: encounter.patientId });
  const notes = await db
    .collection<ClinicalNote>("clinicalNotes")
    .find({ encounterId: encounter._id })
    .sort({ createdAt: 1 })
    .toArray();
  const labPanel = await db.collection<LabPanel>("labPanels").findOne({ encounterId: encounter._id });
  const imaging = await db
    .collection<ImagingRequest>("imagingRequests")
    .find({ encounterId: encounter._id })
    .sort({ requestedAt: -1 })
    .toArray();
  const referrals = await db
    .collection<ReferralConsult>("referralConsults")
    .find({ encounterId: encounter._id })
    .sort({ referredAt: -1 })
    .toArray();
  const treatmentLog = await db.collection<TreatmentLog>("treatmentLogs").findOne({ encounterId: encounter._id });
  let operation = await db.collection<OperationForm>("operationForms").findOne({ encounterId: encounter._id });
  const discharge = await db.collection<DischargeForm>("dischargeForms").findOne({ encounterId: encounter._id });

  if (operation) {
    const opUserIds = [...new Set([operation.surgeon, ...(operation.assistants || [])].map((id) => id.toString()))];
    const opUsers = opUserIds.length
      ? await db.collection("users").find({ _id: { $in: opUserIds.map(toObjectId) } }).toArray()
      : [];
    const opUserMap = new Map(opUsers.map((u: any) => [u._id.toString(), u.fullName]));
    const enriched: WithId<OperationForm> & { surgeonName: string; assistantNames: string[] } = {
      ...operation,
      surgeonName: opUserMap.get(operation.surgeon.toString()) || "Unknown",
      assistantNames: (operation.assistants || []).map((id) => opUserMap.get(id.toString()) || "Unknown"),
    };
    operation = enriched;
  }

  const noteAuthors = await db
    .collection("users")
    .find({ _id: { $in: [...new Set(notes.map((n) => n.authoredBy.toString()))].map(toObjectId) } })
    .toArray();
  const authorMap = new Map(noteAuthors.map((a: any) => [a._id.toString(), a.fullName]));

  return Response.json({
    encounter,
    patient,
    notes: notes.map((n) => ({ ...n, authorName: authorMap.get(n.authoredBy.toString()) || "Unknown" })),
    labPanel,
    imaging,
    referrals,
    treatmentLog,
    operation,
    discharge,
  });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  // Status transitions / admit-to-ward / type escalation — resident only (spec §7).
  const session = await requireRole(["resident"]);
  if (!session) return Response.json({ error: "Resident only" }, { status: 403 });
  const userId = toObjectId((session.user as any).id);

  const body = await req.json();
  const db = await getDb();
  if (!isValidObjectId(params.id)) return Response.json({ error: "Invalid encounter id" }, { status: 400 });
  const encounter = await db.collection<Encounter>("encounters").findOne({ _id: toObjectId(params.id) });
  if (!encounter) return Response.json({ error: "Not found" }, { status: 404 });

  // Admit-to-ward SPAWNS a new ward encounter (spec §4.1 step 3) rather than
  // mutating the emergency/clinic encounter's type. The source encounter closes;
  // the ward encounter carries the patient forward.
  if (body.action === "admit") {
    if (!["male", "female"].includes(body.ward)) {
      return Response.json({ error: "ward (male|female) is required to admit to ward" }, { status: 400 });
    }
    const now = new Date();
    const wardDoc: Encounter = {
      patientId: encounter.patientId,
      type: "ward",
      caseType: encounter.caseType,
      customCaseTypeLabel: encounter.customCaseTypeLabel ?? null,
      status: "active",
      ward: body.ward,
      openedAt: now,
      closedAt: null,
      openedBy: userId,
      linkedFollowUpOf: null,
    };
    const res = await db.collection<Encounter>("encounters").insertOne(wardDoc);
    await logAudit({
      collection: "encounters",
      documentId: res.insertedId,
      action: "create",
      summary: `Admitted patient from ${encounter.type} encounter to ${body.ward} ward (spawned ward encounter)`,
      performedBy: userId,
    });

    await db.collection<Encounter>("encounters").updateOne(
      { _id: encounter._id },
      { $set: { status: "closed", closedAt: now } }
    );
    await logAudit({
      collection: "encounters",
      documentId: encounter._id,
      action: "update",
      summary: `Closed ${encounter.type} encounter after admit-to-ward`,
      performedBy: userId,
    });

    const created = await db.collection<Encounter>("encounters").findOne({ _id: res.insertedId });
    return Response.json({ ...created, spawnedFrom: encounter._id }, { status: 201 });
  }

  const update: Record<string, unknown> = { ...body };
  delete update.patientId;
  delete update.action;

  if (body.type && body.type !== encounter.type) {
    if (body.type === "ward") {
      if (!["male", "female"].includes(body.ward)) {
        return Response.json({ error: "ward (male|female) is required to admit to ward" }, { status: 400 });
      }
      update.ward = body.ward;
    } else if (body.type === "emergency") {
      // Spec §4.1 step 5: clinic → emergency escalation without re-entering data.
      update.ward = ["male", "female"].includes(body.ward) ? body.ward : null;
    } else {
      return Response.json({ error: "Invalid encounter type" }, { status: 400 });
    }
  }

  if (body.status === "closed" || body.status === "discharged" || body.status === "referred-out") {
    update.closedAt = new Date();
  }
  if (body.status === "active") {
    update.closedAt = null;
  }
  // Follow-up linkage (spec §4): an explicit linkedFollowUpOf links a follow-up
  // visit to its prior discharge encounter. Never self-link.
  if ("linkedFollowUpOf" in body) {
    if (body.linkedFollowUpOf === null || body.linkedFollowUpOf === undefined || body.linkedFollowUpOf === "") {
      update.linkedFollowUpOf = null;
    } else {
      if (!isValidObjectId(body.linkedFollowUpOf)) {
        return Response.json({ error: "Invalid linkedFollowUpOf" }, { status: 400 });
      }
      if (body.linkedFollowUpOf.toString() === encounter._id.toString()) {
        return Response.json({ error: "An encounter cannot be linked to itself" }, { status: 400 });
      }
      const linked = await db.collection<Encounter>("encounters").findOne({ _id: toObjectId(body.linkedFollowUpOf) });
      if (!linked) return Response.json({ error: "Linked follow-up encounter not found" }, { status: 404 });
      update.linkedFollowUpOf = toObjectId(body.linkedFollowUpOf);
    }
  }

  await db.collection<Encounter>("encounters").updateOne(
    { _id: encounter._id },
    { $set: update }
  );

  await logAudit({
    collection: "encounters",
    documentId: encounter._id,
    action: "update",
    summary: `Updated encounter: ${Object.keys(body).join(", ")}`,
    performedBy: userId,
  });

  const updated = await db.collection<Encounter>("encounters").findOne({ _id: encounter._id });
  return Response.json(updated);
}
