import { requireRole } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { toObjectId } from "@/lib/api";
import type { LabImport, Patient } from "@/lib/models/types";

// Resolve a "needs-review" lab import: link it to a patient code (creating a
// Patient if needed) and re-attempt auto-matching to an active encounter.
export async function POST(req: Request) {
  const session = await requireRole(["resident", "admin"]);
  if (!session) return Response.json({ error: "Resident or admin only" }, { status: 403 });
  const userId = toObjectId((session.user as any).id);

  const body = await req.json();
  const { importId, medicalNumber, fullName } = body;
  if (!importId) return Response.json({ error: "importId is required" }, { status: 400 });

  const db = await getDb();
  const labImport = await db.collection<LabImport>("labImports").findOne({ _id: toObjectId(importId) });
  if (!labImport) return Response.json({ error: "Import not found" }, { status: 404 });

  let patient: (Patient & { _id?: any }) | null = await db.collection<Patient>("patients").findOne({ medicalNumber });
  if (!patient && medicalNumber && fullName) {
    const now = new Date();
    patient = {
      medicalNumber,
      fullName,
      sex: "male",
      age: 0,
      labPatientCode: labImport.patientCode,
      createdAt: now,
      updatedAt: now,
    };
    const res = await db.collection<Patient>("patients").insertOne(patient);
    patient._id = res.insertedId;
  } else if (patient && !patient.labPatientCode) {
    await db.collection<Patient>("patients").updateOne(
      { _id: patient._id },
      { $set: { labPatientCode: labImport.patientCode } }
    );
  }

  if (!patient) {
    return Response.json({ error: "Patient not found — provide medicalNumber and fullName to create one" }, { status: 400 });
  }

  // Re-attempt matching: link any active encounter for this patient.
  const encounter = await db.collection("encounters")
    .findOne({ patientId: patient._id, status: "active" }, { sort: { openedAt: -1 } as any });

  const update: Record<string, unknown> = {
    matchedPatientId: patient._id,
    status: "matched",
    reviewReason: null,
  };
  if (encounter) update.matchedEncounterId = encounter._id;

  await db.collection<LabImport>("labImports").updateOne(
    { _id: labImport._id },
    { $set: update }
  );

  await logAudit({
    collection: "labImports",
    documentId: labImport._id,
    action: "update",
    summary: `Reviewed import: linked to patient ${patient.fullName} (${medicalNumber})`,
    performedBy: userId,
  });

  return Response.json({ ...labImport, ...update });
}
