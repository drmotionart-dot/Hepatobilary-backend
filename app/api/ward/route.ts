import { requireSession } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";
import type { Encounter, Patient, ClinicalNote } from "@/lib/models/types";

// Ward list for one side (male/female): every active inpatient with its
// patient record and the most recent clinical note's presenting line.
export async function GET(req: Request) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const ward = url.searchParams.get("ward") === "female" ? "female" : "male";

  const db = await getDb();
  const encounters = await db.collection<Encounter>("encounters")
    .find({ status: "active", type: "ward", ward })
    .sort({ openedAt: -1 })
    .toArray();

  const patientIds = [...new Set(encounters.map((e) => e.patientId.toString()))];
  const patients = patientIds.length
    ? await db.collection<Patient>("patients").find({ _id: { $in: patientIds.map((id) => new ObjectId(id)) } }).toArray()
    : [];
  const patientMap = new Map(patients.map((p) => [p._id!.toString(), p]));

  const encounterIds = encounters.map((e) => e._id!.toString());
  const notes = encounterIds.length
    ? await db.collection<ClinicalNote>("clinicalNotes")
        .find({ encounterId: { $in: encounterIds.map((id) => new ObjectId(id)) } })
        .sort({ createdAt: 1 })
        .toArray()
    : [];
  const notesByEncounter = new Map<string, ClinicalNote[]>();
  for (const n of notes) {
    const key = n.encounterId.toString();
    if (!notesByEncounter.has(key)) notesByEncounter.set(key, []);
    notesByEncounter.get(key)!.push(n);
  }

  return Response.json(
    encounters.map((e) => {
      const noteList = notesByEncounter.get(e._id!.toString()) || [];
      return {
        ...e,
        patient: patientMap.get(e.patientId.toString()) || null,
        lastNote: noteList.length ? noteList[noteList.length - 1] : null,
      };
    })
  );
}
