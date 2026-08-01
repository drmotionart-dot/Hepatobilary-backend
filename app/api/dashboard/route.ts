import { requireSession } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";
import { SHIFT_START_HOUR, activeShiftDate, localDateKey } from "@/lib/shift";
import { resolveDayType, resolveDayTypes, slotAppliesOnDay } from "@/lib/day-type";
import type { Encounter, LabImport, RoleSlotDefinition, ShiftAssignment } from "@/lib/models/types";

// Everything the frontend dashboard renders in one call: the live clock + the
// 08:00 shift window, today's on-shift snapshot (spec §8 "who's on shift now"
// card), the three headline counters, the follow-up queue, and the current
// month summary that drives the calendar card (spec §6).
export async function GET() {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const db = await getDb();
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);

  // Stored DayTypeCalendar wins; otherwise weekday defaults (Thu→clinic,
  // Sun/Wed→normal+surgeryOverlay, else normal).
  const todayResolved = await resolveDayType(startOfDay);
  const dayType = todayResolved.dayType;
  const surgeryOverlay = todayResolved.surgeryOverlay;

  // Who's on shift now follows the 08:00 boundary: before 08:00 the previous
  // day's 24h shift (08:00 → 08:00) is still the active one.
  const activeStart = activeShiftDate(now);
  const activeEnd = new Date(activeStart);
  activeEnd.setDate(activeEnd.getDate() + 1);

  const assignments = await db.collection<ShiftAssignment>("shiftAssignments")
    .find({ date: { $gte: activeStart, $lt: activeEnd } })
    .toArray();

  const userIds = [...new Set(assignments.flatMap((a: any) => (a.userIds || []).map((u: any) => u.toString())))];
  const users = userIds.length
    ? await db.collection("users").find({ _id: { $in: userIds.map((id) => new ObjectId(id)) } }).toArray()
    : [];
  const userMap = new Map(users.map((u: any) => [u._id.toString(), u.fullName]));

  const slotIds = assignments.map((a: any) => a.roleSlotDefinitionId.toString());
  const slots = slotIds.length
    ? await db.collection<RoleSlotDefinition>("roleSlotDefinitions").find({ _id: { $in: slotIds.map((id) => new ObjectId(id)) } }).toArray()
    : [];
  const slotMap = new Map(slots.map((s: any) => [s._id.toString(), s]));

  // The "on shift now" card reflects the ACTIVE shift day (before 08:00 that is
  // still the previous day's 24h shift). Only people in slots that APPLY on that
  // day count (slotAppliesOnDay — same rule the roster board renders), and
  // anyone marked absent (spec 6.2) is excluded, so the card matches the roster.
  const activeResolved = await resolveDayType(activeStart);
  const absentOn = new Set<string>();
  for (const a of assignments) {
    if (Array.isArray(a.absent)) for (const e of a.absent) absentOn.add(e.userId.toString());
  }

  const people = assignments
    .filter((a: any) => slotAppliesOnDay(slotMap.get(a.roleSlotDefinitionId.toString()) as any, activeResolved, activeStart))
    .flatMap((a: any) =>
      (a.userIds || [])
        .filter((u: any) => !absentOn.has(u.toString()))
        .map((u: any) => ({
          id: u.toString(),
          name: userMap.get(u.toString()) || "Unknown",
          category: slotMap.get(a.roleSlotDefinitionId.toString())?.label || "",
          startTime: a.startTime || null,
          endTime: a.endTime || null,
        }))
    )
    .filter((p: any) => p.name !== "Unknown");

  const activeShift = people.length > 0 ? "assigned" : "unassigned";

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

  // Current-month summary for the calendar card: resolved day type (stored wins,
  // weekday default otherwise) + how many people are assigned each day. The
  // count only includes people in slots that APPLY on that day (spec 6, same
  // rule as the roster board) and excludes anyone marked absent (spec 6.2) — so
  // a clinic-only slot never counts on a normal day, and the calendar dots stay
  // in agreement with /roster?day=...
  const monthStart = new Date(startOfDay);
  monthStart.setDate(1);
  const monthEnd = new Date(monthStart);
  monthEnd.setMonth(monthEnd.getMonth() + 1);

  const monthResolved = await resolveDayTypes(
    Array.from({ length: Math.ceil((monthEnd.getTime() - monthStart.getTime()) / 86400000) }, (_, i) => {
      const d = new Date(monthStart);
      d.setDate(d.getDate() + i);
      return d;
    })
  );
  const resolvedByKey = new Map(monthResolved.map((r) => [localDateKey(r.date), r]));

  const monthAssignments = await db.collection<ShiftAssignment>("shiftAssignments").find({ date: { $gte: monthStart, $lt: monthEnd } }).toArray();
  const monthSlots = await db.collection<RoleSlotDefinition>("roleSlotDefinitions").find().toArray();
  const monthSlotById = new Map(monthSlots.map((s) => [s._id!.toString(), s]));

  const assignedPerDay = new Map<string, number>();
  for (const a of monthAssignments) {
    if (!a.userIds || a.userIds.length === 0) continue;
    const key = localDateKey(a.date);
    const r = resolvedByKey.get(key);
    const slot = monthSlotById.get(a.roleSlotDefinitionId.toString());
    if (!r || !slot) continue;
    if (!slotAppliesOnDay(slot, r, new Date(a.date))) continue;
    const absentSet = new Set((a.absent || []).map((e) => e.userId.toString()));
    const count = a.userIds.filter((u) => !absentSet.has(u.toString())).length;
    if (count === 0) continue;
    assignedPerDay.set(key, (assignedPerDay.get(key) || 0) + count);
  }

  const monthDays: { date: string; dayType: string; surgeryOverlay: boolean; assigned: number }[] = [];
  for (let d = new Date(monthStart); d < monthEnd; d.setDate(d.getDate() + 1)) {
    const key = localDateKey(d);
    const r = resolvedByKey.get(key);
    monthDays.push({
      date: key,
      dayType: r?.dayType || "normal",
      surgeryOverlay: r?.surgeryOverlay || false,
      assigned: assignedPerDay.get(key) || 0,
    });
  }

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
    serverNow: now.toISOString(),
    shift: {
      startHour: SHIFT_START_HOUR,
      activeDateKey: localDateKey(activeStart),
      beforeStart: now.getHours() < SHIFT_START_HOUR,
    },
    month: { days: monthDays },
  });
}
