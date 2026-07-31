import { requireSession } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";
import type { DayTypeCalendar, ShiftAssignment, RoleSlotDefinition, User } from "@/lib/models/types";

// Who is on shift today (spec section 7): resolve today's day type, then
// return the assignments for today grouped by shift window.
export async function GET() {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const db = await getDb();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);

  const dayTypeDoc = await db.collection<DayTypeCalendar>("dayTypeCalendar").findOne({
    date: { $gte: startOfDay, $lt: endOfDay },
  });
  const dayType = dayTypeDoc?.dayType || "normal";

  const assignments = await db.collection<ShiftAssignment>("shiftAssignments")
    .find({ date: { $gte: startOfDay, $lt: endOfDay } })
    .toArray();

  const userIds = [...new Set(assignments.filter((a) => a.userId).map((a) => a.userId!.toString()))];
  const users = userIds.length
    ? await db.collection<User>("users").find({ _id: { $in: userIds.map((id) => new ObjectId(id)) } }).toArray()
    : [];
  const userMap = new Map(users.map((u) => [u._id!.toString(), u]));

  const slotIds = assignments.map((a) => a.roleSlotDefinitionId.toString());
  const slots = slotIds.length
    ? await db.collection<RoleSlotDefinition>("roleSlotDefinitions").find({ _id: { $in: slotIds.map((id) => new ObjectId(id)) } }).toArray()
    : [];
  const slotMap = new Map(slots.map((s) => [s._id!.toString(), s]));

  const grouped = assignments.map((a) => ({
    assignment: a,
    slot: slotMap.get(a.roleSlotDefinitionId.toString()) || null,
    user: a.userId ? userMap.get(a.userId.toString()) || null : null,
  }));

  return Response.json({ dayType, surgeryOverlay: dayTypeDoc?.surgeryOverlay || false, assignments: grouped });
}

