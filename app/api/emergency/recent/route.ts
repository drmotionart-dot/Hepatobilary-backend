import { requireSession } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";
import type { Encounter, Patient, ClinicalNote } from "@/lib/models/types";

// Emergency page: the last 24h of emergency assessments with patient info and
// a one-line summary from the emergency-assessment clinical note.
export async function GET() {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const db = await getDb();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const encounters = await db.collection<Encounter>("encounters")
    .find({ type: "emergency", openedAt: { $gte: since } })
    .sort({ openedAt: -1 })
    .limit(20)
    .toArray();

  const patientIds = [...new Set(encounters.map((e) => e.patientId.toString()))];
  const patients = patientIds.length
    ? await db.collection<Patient>("patients").find({ _id: { $in: patientIds.map((id) => new ObjectId(id)) } }).toArray()
    : [];
  const patientMap = new Map(patients.map((p) => [p._id!.toString(), p]));

  const encounterIds = encounters.map((e) => e._id!.toString());
  const notes = encounterIds.length
    ? await db.collection<ClinicalNote>("clinicalNotes")
        .find({ encounterId: { $in: encounterIds.map((id) => new ObjectId(id)) }, context: "emergency-assessment" })
        .toArray()
    : [];
  const notesByEncounter = new Map<string, string>();
  for (const n of notes) {
    if (!notesByEncounter.has(n.encounterId.toString())) {
      notesByEncounter.set(n.encounterId.toString(), n.complaint?.main || n.presentingLine || "");
    }
  }

  return Response.json(
    encounters.map((e) => ({
      ...e,
      patient: patientMap.get(e.patientId.toString()) || null,
      noteSummary: notesByEncounter.get(e._id!.toString()) || "",
    }))
  );
}
