import { requireCapability, toObjectId, isValidObjectId } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import type { Attendance, ShiftAssignment, User } from "@/lib/models/types";

// Mark/un-mark an assigned intern absent (spec 6.2). The user stays in the
// slot's userIds — the roster records "assigned but absent" — so removing them
// from the duty group is never conflated with marking them absent. Marking also
// mirrors a note ("absent — <reason>") into the attendance record, but never
// overwrites an explicitly-present attendance entry, and un-marking does not
// touch attendance.
function dayRange(date: string) {
  const start = new Date(date);
  if (Number.isNaN(start.getTime())) return null;
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

export async function POST(req: Request) {
  const session = await requireCapability("manage-roster");
  if (!session) return Response.json({ error: "Requires the manage-roster capability" }, { status: 403 });
  const actingId = toObjectId((session.user as any).id);

  const body = await req.json();
  const { date, roleSlotDefinitionId, userId, absentReason } = body;

  if (!date || !isValidObjectId(roleSlotDefinitionId) || !isValidObjectId(userId)) {
    return Response.json({ error: "date, roleSlotDefinitionId and userId are required" }, { status: 400 });
  }
  if (typeof absentReason !== "string" || !absentReason.trim()) {
    return Response.json({ error: "absentReason is required" }, { status: 400 });
  }

  const range = dayRange(date);
  if (!range) return Response.json({ error: "Invalid date" }, { status: 400 });

  const db = await getDb();
  const assignment = await db.collection<ShiftAssignment>("shiftAssignments").findOne({
    date: { $gte: range.start, $lt: range.end },
    roleSlotDefinitionId: toObjectId(roleSlotDefinitionId),
  });
  if (!assignment) return Response.json({ error: "Shift slot not found" }, { status: 404 });
  if (!(assignment.userIds || []).map((u) => u.toString()).includes(userId)) {
    return Response.json({ error: "User is not assigned to this slot" }, { status: 400 });
  }

  const user = await db.collection<User>("users").findOne({ _id: toObjectId(userId) }, { projection: { fullName: 1 } });
  if (!user) return Response.json({ error: "User not found" }, { status: 404 });

  const now = new Date();
  const absent = (assignment.absent || []).filter((e) => e.userId.toString() !== userId);
  absent.push({ userId: toObjectId(userId), absentReason: absentReason.trim(), absentMarkedBy: actingId, absentMarkedAt: now });

  await db.collection<ShiftAssignment>("shiftAssignments").updateOne(
    { _id: assignment._id },
    { $set: { absent } }
  );

  // Mirror into attendance as an "absent" mark carrying the reason as its note,
  // unless an admin/resident already explicitly marked this person present.
  const day = range.start;
  const existingAttendance = await db.collection<Attendance>("attendance").findOne({ userId: toObjectId(userId), date: day });
  if (!existingAttendance || existingAttendance.status !== "present") {
    await db.collection<Attendance>("attendance").updateOne(
      { userId: toObjectId(userId), date: day },
      {
        $set: {
          userId: toObjectId(userId),
          date: day,
          status: "absent",
          note: `Absent — ${absentReason.trim()}`,
          markedBy: actingId,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );
  }

  await logAudit({
    collection: "shiftAssignments",
    documentId: assignment._id!,
    action: "update",
    summary: `Marked ${user.fullName} absent on ${range.start.toISOString().slice(0, 10)} (${absentReason.trim()})`,
    performedBy: actingId,
  });

  const updated = await db.collection<ShiftAssignment>("shiftAssignments").findOne({ _id: assignment._id });
  return Response.json(updated);
}

export async function DELETE(req: Request) {
  const session = await requireCapability("manage-roster");
  if (!session) return Response.json({ error: "Requires the manage-roster capability" }, { status: 403 });
  const actingId = toObjectId((session.user as any).id);

  const body = await req.json();
  const { date, roleSlotDefinitionId, userId } = body;

  if (!date || !isValidObjectId(roleSlotDefinitionId) || !isValidObjectId(userId)) {
    return Response.json({ error: "date, roleSlotDefinitionId and userId are required" }, { status: 400 });
  }

  const range = dayRange(date);
  if (!range) return Response.json({ error: "Invalid date" }, { status: 400 });

  const db = await getDb();
  const assignment = await db.collection<ShiftAssignment>("shiftAssignments").findOne({
    date: { $gte: range.start, $lt: range.end },
    roleSlotDefinitionId: toObjectId(roleSlotDefinitionId),
  });
  if (!assignment) return Response.json({ error: "Shift slot not found" }, { status: 404 });

  const removed = (assignment.absent || []).find((e) => e.userId.toString() === userId);
  if (!removed) return Response.json(assignment);

  await db.collection<ShiftAssignment>("shiftAssignments").updateOne(
    { _id: assignment._id },
    { $pull: { absent: { userId: toObjectId(userId) } } }
  );

  const user = await db.collection<User>("users").findOne({ _id: toObjectId(userId) }, { projection: { fullName: 1 } });
  await logAudit({
    collection: "shiftAssignments",
    documentId: assignment._id!,
    action: "update",
    summary: `Cleared absence mark for ${user?.fullName || "user"} on ${range.start.toISOString().slice(0, 10)}`,
    performedBy: actingId,
  });

  const updated = await db.collection<ShiftAssignment>("shiftAssignments").findOne({ _id: assignment._id });
  return Response.json(updated);
}
