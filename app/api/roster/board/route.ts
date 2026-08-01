import { requireSession } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import type { User, RoleSlotDefinition, ShiftAssignment, DayTypeCalendar, EmergencyDayPool } from "@/lib/models/types";

// The 8-week roster board in one call: active users, the slot rulebook, the
// existing assignments, the day-type calendar, and the emergency-duty pools
// (spec 6.1) over the same window.
export async function GET() {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const db = await getDb();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setDate(end.getDate() + 56);

  const [users, slots, assignments, calendar, pools] = await Promise.all([
    db.collection<User>("users").find({ status: "active" }).project({ passwordHash: 0 }).sort({ fullName: 1 }).toArray(),
    db.collection<RoleSlotDefinition>("roleSlotDefinitions").find().toArray(),
    db.collection<ShiftAssignment>("shiftAssignments").find({ date: { $gte: today, $lt: end } }).toArray(),
    db.collection<DayTypeCalendar>("dayTypeCalendar").find({ date: { $gte: today, $lt: end } }).toArray(),
    db.collection<EmergencyDayPool>("emergencyDayPools").find({ date: { $gte: today, $lt: end } }).toArray(),
  ]);

  return Response.json({ users, slots, assignments, calendar, pools });
}
