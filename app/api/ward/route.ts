import { requireSession } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";
import type { Encounter, Patient, ClinicalNote, LabPanel, ImagingRequest } from "@/lib/models/types";

const dayKey = (d: string | Date) => {
  const x = new Date(d);
  return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
};

function dayOfStay(openedAt: string | Date): number {
  return Math.max(1, Math.round((dayKey(new Date()) - dayKey(openedAt)) / 86400000) + 1);
}

// Ward board: every active inpatient on both sides, enriched for the
// day-by-day view (day of stay, labs/imaging pending, discharge readiness).
export async function GET(_req: Request) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const db = await getDb();
  const encounters = await db.collection<Encounter>("encounters")
    .find({ status: "active", type: "ward" })
    .sort({ openedAt: -1 })
    .toArray();

  const patientIds = [...new Set(encounters.map((e) => e.patientId.toString()))];
  const patients = patientIds.length
    ? await db.collection<Patient>("patients").find({ _id: { $in: patientIds.map((id) => new ObjectId(id)) } }).toArray()
    : [];
  const patientMap = new Map(patients.map((p) => [p._id!.toString(), p]));

  const encounterIds = encounters.map((e) => e._id!.toString());
  const idSet = encounterIds.length ? encounterIds.map((id) => new ObjectId(id)) : [];

  const notes = idSet.length
    ? await db.collection<ClinicalNote>("clinicalNotes").find({ encounterId: { $in: idSet } }).sort({ createdAt: 1 }).toArray()
    : [];
  const notesByEncounter = new Map<string, ClinicalNote[]>();
  for (const n of notes) {
    const key = n.encounterId.toString();
    if (!notesByEncounter.has(key)) notesByEncounter.set(key, []);
    notesByEncounter.get(key)!.push(n);
  }

  const panels = idSet.length
    ? await db.collection<LabPanel>("labPanels").find({ encounterId: { $in: idSet } }).toArray()
    : [];
  const panelByEncounter = new Map<string, LabPanel>();
  for (const p of panels) panelByEncounter.set(p.encounterId.toString(), p);

  const pendingImaging = idSet.length
    ? await db.collection<ImagingRequest>("imagingRequests")
        .find({ encounterId: { $in: idSet }, status: { $in: ["requested", "scheduled"] } })
        .toArray()
    : [];
  const pendingImagingSet = new Set(pendingImaging.map((i) => i.encounterId.toString()));

  const today = dayKey(new Date());
  const cards = encounters.map((e) => {
    const noteList = notesByEncounter.get(e._id!.toString()) || [];
    const lastNote = noteList.length ? noteList[noteList.length - 1] : null;
    const panel = panelByEncounter.get(e._id!.toString());
    const latestLabDate = panel?.results?.length
      ? Math.max(...panel.results.map((r) => dayKey(r.date)))
      : 0;
    const labsPending = !panel || latestLabDate < today;
    const imagingPending = pendingImagingSet.has(e._id!.toString());
    const readyForDischarge = !labsPending && !imagingPending && noteList.length > 0;
    return {
      ...e,
      patient: patientMap.get(e.patientId.toString()) || null,
      lastNote,
      dayOfStay: dayOfStay(e.openedAt),
      labsPending,
      imagingPending,
      readyForDischarge,
    };
  });

  const male = cards.filter((c) => c.ward === "male");
  const female = cards.filter((c) => c.ward === "female");

  return Response.json({ male, female });
}
