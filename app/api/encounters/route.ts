import { requireRole, toObjectId, isValidObjectId } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import type { Encounter, Patient, LabPanel } from "@/lib/models/types";

export async function GET(req: Request) {
  const session = await requireRole(["intern", "resident", "admin"]);
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
  if (patientId) {
    if (!isValidObjectId(patientId)) return Response.json({ error: "Invalid patientId" }, { status: 400 });
    filter.patientId = toObjectId(patientId);
  }

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
  // Opening clinical encounters is intern/resident only (spec §7 — admin reads).
  const session = await requireRole(["intern", "resident"]);
  if (!session) return Response.json({ error: "Intern or resident only" }, { status: 403 });
  const userId = toObjectId((session.user as any).id);

  const body = await req.json();
  const { patientId, type, caseType, customCaseTypeLabel, ward, status } = body;
  if (!patientId || !type || !caseType) {
    return Response.json({ error: "patientId, type and caseType are required" }, { status: 400 });
  }
  if (!isValidObjectId(patientId)) {
    return Response.json({ error: "Invalid patientId" }, { status: 400 });
  }
  if (!["emergency", "ward", "clinic"].includes(type)) {
    return Response.json({ error: "Invalid encounter type" }, { status: 400 });
  }
  if (!["hernia", "biliary", "hepatic", "custom"].includes(caseType)) {
    return Response.json({ error: "Invalid case type" }, { status: 400 });
  }
  if (caseType === "custom" && !customCaseTypeLabel?.trim()) {
    return Response.json({ error: "customCaseTypeLabel is required when caseType is custom" }, { status: 400 });
  }

  const db = await getDb();
  const patient = await db.collection<Patient>("patients").findOne({ _id: toObjectId(patientId) });
  if (!patient) return Response.json({ error: "Patient not found" }, { status: 404 });

  const now = new Date();
  const doc: Encounter = {
    patientId: toObjectId(patientId),
    type,
    caseType,
    customCaseTypeLabel: caseType === "custom" ? customCaseTypeLabel.trim() : null,
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
    summary: `Opened ${type} encounter (${caseType === "custom" ? customCaseTypeLabel.trim() : caseType}) for ${patient.fullName}`,
    performedBy: userId,
  });

  // Spec 3.6 / 4.3: pre-seed the LabPanel with the case type's labPanelPreset
  // (empty, awaiting values) the moment the encounter is opened. Custom cases
  // have no template preset, so they start with an empty panel.
  if (caseType !== "custom") {
    try {
      const template = await db
        .collection<{ name: string; labPanelPreset: string[] }>("caseTypeTemplates")
        .findOne({ name: { $regex: new RegExp(`^${caseType}$`, "i") }, active: true });
      if (template?.labPanelPreset?.length) {
        const preseedRes = await db.collection<LabPanel>("labPanels").insertOne({
          encounterId: res.insertedId,
          results: [],
          presetTests: template.labPanelPreset,
        });
        void logAudit({
          collection: "labPanels",
          documentId: preseedRes.insertedId,
          action: "create",
          summary: `Pre-seeded lab panel (${template.labPanelPreset.length} preset tests) for ${caseType} encounter`,
          performedBy: userId,
        });
      }
    } catch (err) {
      console.error("Failed to pre-seed lab panel:", err);
    }
  }

  return Response.json({ ...doc, _id: res.insertedId }, { status: 201 });
}
