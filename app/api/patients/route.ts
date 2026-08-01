import { requireRole } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { toObjectId } from "@/lib/api";
import type { Patient } from "@/lib/models/types";

export async function GET(req: Request) {
  const session = await requireRole(["intern", "resident", "admin"]);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);

  const db = await getDb();
  const filter: Record<string, unknown> = {};
  if (q) {
    filter.$or = [
      { medicalNumber: { $regex: q, $options: "i" } },
      { fullName: { $regex: q, $options: "i" } },
    ];
  }

  const patients = await db
    .collection<Patient>("patients")
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();

  return Response.json(patients);
}

export async function POST(req: Request) {
  // Creating patients is intern/resident/admin (spec §7, amended).
  const session = await requireRole(["intern", "resident", "admin"]);
  if (!session) return Response.json({ error: "Intern or resident only" }, { status: 403 });
  const userId = toObjectId((session.user as any).id);

  const body = await req.json();
  const { medicalNumber, fullName, sex, age } = body;
  if (!medicalNumber || !fullName || !sex || !age) {
    return Response.json({ error: "medicalNumber, fullName, sex and age are required" }, { status: 400 });
  }
  if (!["male", "female"].includes(sex)) {
    return Response.json({ error: "sex must be male or female" }, { status: 400 });
  }
  const ageNum = Number(age);
  if (!Number.isFinite(ageNum) || ageNum < 0 || ageNum > 130) {
    return Response.json({ error: "age must be a number between 0 and 130" }, { status: 400 });
  }

  const db = await getDb();
  const existing = await db.collection<Patient>("patients").findOne({ medicalNumber });
  if (existing) {
    return Response.json({ error: "Patient with this medical number already exists" }, { status: 409 });
  }

  const now = new Date();
  const doc: Patient = {
    medicalNumber,
    fullName,
    sex,
    age: ageNum,
    createdAt: now,
    updatedAt: now,
  };
  const res = await db.collection<Patient>("patients").insertOne(doc);

  await logAudit({
    collection: "patients",
    documentId: res.insertedId,
    action: "create",
    summary: `Created patient ${fullName} (${medicalNumber})`,
    performedBy: userId,
  });

  return Response.json({ ...doc, _id: res.insertedId }, { status: 201 });
}
