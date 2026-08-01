import { requireSession } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";
import { SHIFT_START_HOUR, activeShiftDate, localDateKey } from "@/lib/shift";
import { resolveDayType, resolveDayTypes } from "@/lib/day-type";
import type { Encounter, LabImport } from "@/lib/models/types";

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

  const assignments = await db.collection("shiftAssignments")
    .find({ date: { $gte: activeStart, $lt: activeEnd } })
    .toArray();

  const userIds = [...new Set(assignments.flatMap((a: any) => (a.userIds || []).map((u: any) => u.toString())))];
  const users = userIds.length
    ? await db.collection("users").find({ _id: { $in: userIds.map((id) => new ObjectId(id)) } }).toArray()
    : [];
  const userMap = new Map(users.map((u: any) => [u._id.toString(), u.fullName]));

  const slotIds = assignments.map((a: any) => a.roleSlotDefinitionId.toString());
  const slots = slotIds.length
    ? await db.collection("roleSlotDefinitions").find({ _id: { $in: slotIds.map((id) => new ObjectId(id)) } }).toArray()
    : [];
  const slotMap = new Map(slots.map((s: any) => [s._id.toString(), s.label]));

  const people = assignments
    .flatMap((a: any) =>
      (a.userIds || []).map((u: any) => ({
        name: userMap.get(u.toString()) || "Unknown",
        category: slotMap.get(a.roleSlotDefinitionId.toString()) || "",
        startTime: a.startTime || null,
        endTime: a.endTime || null,
      }))
    )
    .filter((p: any) => p.name !== "Unknown");

  const activeShift = assignments.some((a: any) => a.userIds && a.userIds.length > 0) ? "assigned" : "unassigned";

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
  // weekday default otherwise) + how many people are assigned each day.
  const monthStart = new Date(startOfDay);
  monthStart.setDate(1);
  const monthEnd = new Date(monthStart);
  monthEnd.setMonth(monthEnd.getMonth() + 1);

  const monthAssignments = await db.collection("shiftAssignments").find({ date: { $gte: monthStart, $lt: monthEnd } }).toArray();
  const assignedPerDay = new Map<string, number>();
  for (const a of monthAssignments as any[]) {
    if (!a.userIds || a.userIds.length === 0) continue;
    const key = localDateKey(a.date);
    assignedPerDay.set(key, (assignedPerDay.get(key) || 0) + a.userIds.length);
  }

  const monthResolved = await resolveDayTypes(
    Array.from({ length: Math.ceil((monthEnd.getTime() - monthStart.getTime()) / 86400000) }, (_, i) => {
      const d = new Date(monthStart);
      d.setDate(d.getDate() + i);
      return d;
    })
  );
  const resolvedByKey = new Map(monthResolved.map((r) => [localDateKey(r.date), r]));
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
