import { requireSession } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";
import type { DayTypeCalendar, ShiftAssignment, RoleSlotDefinition, User } from "@/lib/models/types";
import { activeShiftDate } from "@/lib/shift";

// Who is on shift now (spec section 7): resolve the active shift's day type,
// then return the assignments for that day grouped by shift window. Uses the
// same 08:00 → 08:00 shift boundary as the dashboard, so before 08:00 "on
// shift now" means the previous calendar day.
export async function GET() {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const db = await getDb();
  const startOfDay = activeShiftDate();
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);

  const dayTypeDoc = await db.collection<DayTypeCalendar>("dayTypeCalendar").findOne({
    date: { $gte: startOfDay, $lt: endOfDay },
  });
  const dayType = dayTypeDoc?.dayType || "normal";

  const assignments = await db.collection<ShiftAssignment>("shiftAssignments")
    .find({ date: { $gte: startOfDay, $lt: endOfDay } })
    .toArray();

  const userIds = [...new Set(assignments.flatMap((a) => (a.userIds || []).map((u) => u.toString())))];
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
    users: (a.userIds || []).map((u) => userMap.get(u.toString()) || null).filter(Boolean),
  }));

  return Response.json({ dayType, surgeryOverlay: dayTypeDoc?.surgeryOverlay || false, assignments: grouped });
}

