import { requireSession } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";
import type { Encounter, LabImport } from "@/lib/models/types";

// Everything the frontend dashboard renders in one call: today's on-shift
// snapshot (spec §8 "who's on shift now" card), the three headline counters,
// and the follow-up queue.
export async function GET() {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const db = await getDb();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);

  const dayTypeDoc = await db.collection("dayTypeCalendar").findOne({ date: { $gte: startOfDay, $lt: endOfDay } });
  const dayType = (dayTypeDoc?.dayType as string) || "normal";
  const surgeryOverlay = Boolean(dayTypeDoc?.surgeryOverlay);

  const assignments = await db.collection("shiftAssignments")
    .find({ date: { $gte: startOfDay, $lt: endOfDay } })
    .toArray();

  const userIds = [...new Set(assignments.filter((a) => a.userId).map((a) => a.userId.toString()))];
  const users = userIds.length
    ? await db.collection("users").find({ _id: { $in: userIds.map((id) => new ObjectId(id)) } }).toArray()
    : [];
  const userMap = new Map(users.map((u: any) => [u._id.toString(), u.fullName]));

  const slotIds = assignments.map((a) => a.roleSlotDefinitionId.toString());
  const slots = slotIds.length
    ? await db.collection("roleSlotDefinitions").find({ _id: { $in: slotIds.map((id) => new ObjectId(id)) } }).toArray()
    : [];
  const slotMap = new Map(slots.map((s: any) => [s._id.toString(), s.label]));

  const people = assignments
    .filter((a) => a.userId)
    .map((a) => ({
      name: userMap.get(a.userId.toString()) || "Unknown",
      category: slotMap.get(a.roleSlotDefinitionId.toString()) || "",
    }));

  const activeShift = assignments.some((a) => a.userId) ? "assigned" : "unassigned";

  const [activeWard, followUpPending, needsReviewImports] = await Promise.all([
    db.collection<Encounter>("encounters").countDocuments({ status: "active", type: "ward" }),
    db.collection<Encounter>("encounters").countDocuments({ status: "follow-up-pending" }),
    db.collection<LabImport>("labImports").countDocuments({ status: "needs-review" }),
  ]);

  const followUps = await db.collection<Encounter>("encounters")
    .find({ status: "follow-up-pending" })
    .sort({ openedAt: -1 })
    .limit(5)
    .toArray();
  const followUpPatientIds = [...new Set(followUps.map((e) => e.patientId.toString()))];
  const patients = followUpPatientIds.length
    ? await db.collection("patients").find({ _id: { $in: followUpPatientIds.map((id) => new ObjectId(id)) } }).toArray()
    : [];
  const patientMap = new Map(patients.map((p: any) => [p._id.toString(), p]));

  return Response.json({
    dayType,
    surgeryOverlay,
    activeShift,
    people,
    counters: { activeWard, followUpPending, needsReviewImports },
    followUps: followUps.map((e) => ({
      _id: e._id,
      openedAt: e.openedAt,
      patient: patientMap.get(e.patientId.toString()) || null,
    })),
  });
}
