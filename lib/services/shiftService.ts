// Shift/roster business rules (spec §6, spec 16.1): slot assignment + duty
// groups, absence marks (spec 6.2), intern self-booking (spec 6.1) and the
// roster reads (board/today/export). Routes stay thin — parse + authorize +
// call here + respond. Every rule the frontend depends on (statuses, messages,
// the 08:00 shift boundary, the 8-week window, one-slot-per-day) lives here.

import type { Db, ObjectId, WithId } from "mongodb";
import type { AuthUser } from "@/lib/api";
import { isValidObjectId, toObjectId } from "@/lib/api";
import { HttpError } from "@/lib/http";
import { logAudit } from "@/lib/audit";
import { resolveDayType, resolveDayTypes } from "@/lib/day-type";
import { dayRange, localDateKey } from "@/lib/shift";
import { rosterRepo } from "@/lib/repositories/rosterRepo";
import type { RoleSlotDefinition, ShiftAssignment, User } from "@/lib/models/types";

// Expand a list of assignments with their joined slot + users (shared by the
// assignments GET and roster/today so both return identical shapes).
export interface JoinedAssignment extends ShiftAssignment {
  slot: WithId<RoleSlotDefinition> | null;
  users: WithId<User>[];
}

export async function joinAssignments(db: Db, assignments: ShiftAssignment[]): Promise<JoinedAssignment[]> {
  const userIds = [...new Set(assignments.flatMap((a) => (a.userIds || []).map((u) => u.toString())))];
  const users = userIds.length ? await rosterRepo.findUsersByIds(db, userIds.map(toObjectId)) : [];
  const userMap = new Map(users.map((u) => [u._id!.toString(), u]));

  const slotIds = [...new Set(assignments.map((a) => a.roleSlotDefinitionId.toString()))];
  const slots = slotIds.length ? await rosterRepo.findRoleSlotsByIds(db, slotIds.map(toObjectId)) : [];
  const slotMap = new Map(slots.map((s) => [s._id!.toString(), s]));

  return assignments.map((a) => ({
    ...a,
    slot: slotMap.get(a.roleSlotDefinitionId.toString()) || null,
    users: (a.userIds || []).map((u) => userMap.get(u.toString()) || null).filter((u): u is WithId<User> => u !== null),
  }));
}

// GET /shift/assignments?date=… — without a date returns every assignment
// (sorted by date); with a date returns the day's assignments joined to their
// slot + users.
export async function listAssignments(db: Db, date: string): Promise<{ assignments: JoinedAssignment[] }>;
export async function listAssignments(
  db: Db,
  date: string | null
): Promise<{ assignments: JoinedAssignment[] } | WithId<ShiftAssignment>[]>;
export async function listAssignments(db: Db, date: string | null) {
  if (!date) return rosterRepo.findAssignments(db, {});
  const range = dayRange(date);
  if (!range) throw new HttpError(400, "Invalid date");
  const assignments = await rosterRepo.findAssignmentsBetween(db, range.start, range.end);
  return { assignments: await joinAssignments(db, assignments) };
}

export interface SetAssignmentInput {
  date: string;
  roleSlotDefinitionId: string;
  userIds?: unknown;
  userId?: string;
  startTime?: string;
  endTime?: string;
}

// POST /shift/assignments — replace a slot's duty group (userIds), toggle one
// user (userId), or set start/end time. Users removed from the group drop any
// absence marks (removal ≠ absence, spec 6.2).
export async function setAssignment(
  db: Db,
  input: SetAssignmentInput,
  actingUserId: ObjectId
): Promise<{ doc: ShiftAssignment; status: number }> {
  const { date, roleSlotDefinitionId } = input;
  if (!date || !roleSlotDefinitionId) {
    throw new HttpError(400, "date and roleSlotDefinitionId are required (or from/to for bulk)");
  }
  if (!isValidObjectId(roleSlotDefinitionId)) throw new HttpError(400, "Invalid roleSlotDefinitionId");
  const range = dayRange(date);
  if (!range) throw new HttpError(400, "Invalid date");

  const existing = await rosterRepo.findAssignmentForSlot(db, range.start, range.end, roleSlotDefinitionId);
  const current = (existing?.userIds || []).map((u) => u.toString());

  let nextUserIds: string[];
  if (Array.isArray(input.userIds)) {
    nextUserIds = input.userIds.filter((x: unknown) => typeof x === "string" && x);
  } else if (typeof input.userId === "string" && input.userId) {
    nextUserIds = current.includes(input.userId)
      ? current.filter((x) => x !== input.userId)
      : [...current, input.userId];
  } else {
    nextUserIds = current;
  }

  const fields = {
    userIds: nextUserIds.map((id) => toObjectId(id)),
    startTime: input.startTime || null,
    endTime: input.endTime || null,
  };

  const removedIds = current.filter((id) => !nextUserIds.includes(id));

  if (existing) {
    const update: Record<string, unknown> = { $set: fields };
    if (removedIds.length > 0) {
      update.$pull = { absent: { userId: { $in: removedIds.map(toObjectId) } } };
    }
    await rosterRepo.updateAssignment(db, existing._id!, update);
    await logAudit({
      collection: "shiftAssignments",
      documentId: existing._id!,
      action: "update",
      summary: `Updated shift slot ${roleSlotDefinitionId} on ${date} (${nextUserIds.length} person(s))`,
      performedBy: actingUserId,
    });
    const doc = await rosterRepo.findAssignmentById(db, existing._id!);
    if (!doc) throw new HttpError(404, "Shift slot not found");
    return { doc, status: 200 };
  }

  const doc: ShiftAssignment = {
    date: range.start,
    roleSlotDefinitionId: toObjectId(roleSlotDefinitionId),
    userIds: nextUserIds.map((id) => toObjectId(id)),
    startTime: (input.startTime || null) as string | undefined,
    endTime: (input.endTime || null) as string | undefined,
  };
  const res = await rosterRepo.insertAssignment(db, doc);
  await logAudit({
    collection: "shiftAssignments",
    documentId: res.insertedId,
    action: "create",
    summary: `Assigned slot ${roleSlotDefinitionId} on ${date}`,
    performedBy: actingUserId,
  });
  return { doc: { ...doc, _id: res.insertedId }, status: 201 };
}

// POST /shift/assignments { from, to } — materialize the slot rulebook over a
// date range: stored DayTypeCalendar wins, weekday defaults otherwise, surgery
// overlay adds surgery-partial normal slots, weekdays-restricted slots only on
// their listed days. Idempotent — existing slots are left untouched.
export async function bulkGenerate(
  db: Db,
  from: string,
  to: string,
  actingUserId: ObjectId
): Promise<{ from: string; to: string; created: number }> {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new HttpError(400, "Invalid date range");
  }
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + 1);
  if (start >= end) throw new HttpError(400, "from must be before to");

  const resolvedDays = await resolveDayTypes(
    Array.from({ length: Math.ceil((end.getTime() - start.getTime()) / 86400000) }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return d;
    })
  );
  const resolvedMap = new Map(resolvedDays.map((r) => [localDateKey(r.date), r]));

  const slots = await rosterRepo.findRoleSlots(db);
  const slotsByDayType = new Map<string, RoleSlotDefinition[]>();
  for (const s of slots) {
    const list = slotsByDayType.get(s.dayType) || [];
    list.push(s);
    slotsByDayType.set(s.dayType, list);
  }

  const existing = await rosterRepo.findAssignmentsBetween(db, start, end);
  const existingKeys = new Set(
    existing.map((a) => `${localDateKey(new Date(a.date))}:${a.roleSlotDefinitionId.toString()}`)
  );

  const toInsert: ShiftAssignment[] = [];
  let created = 0;

  for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
    const key = localDateKey(d);
    const resolved = resolvedMap.get(key);
    const dayType = resolved?.dayType || "normal";
    const surgeryOverlay = resolved?.surgeryOverlay || false;

    let daySlots = slotsByDayType.get(dayType) || [];
    if (surgeryOverlay) {
      daySlots = [...daySlots, ...(slotsByDayType.get("normal") || []).filter((s) => s.shiftType === "surgery-partial")];
    }

    for (const slot of daySlots) {
      if (Array.isArray(slot.weekdays) && slot.weekdays.length > 0 && !slot.weekdays.includes(d.getDay())) continue;
      const assignmentKey = `${key}:${slot._id!.toString()}`;
      if (existingKeys.has(assignmentKey)) continue;
      const dateOnly = new Date(d);
      dateOnly.setHours(0, 0, 0, 0);
      toInsert.push({ date: dateOnly, roleSlotDefinitionId: slot._id!, userIds: [], startTime: undefined, endTime: undefined });
      created++;
    }
  }

  if (toInsert.length > 0) {
    const res = await rosterRepo.insertManyAssignments(db, toInsert);
    const firstId = Object.values(res.insertedIds)[0];
    await logAudit({
      collection: "shiftAssignments",
      documentId: firstId,
      action: "create",
      summary: `Bulk-generated ${created} shift slots for ${from} → ${to}`,
      performedBy: actingUserId,
    });
  }

  return { from, to, created };
}

export interface AbsentInput {
  date: string;
  roleSlotDefinitionId: string;
  userId: string;
  absentReason: string;
}

// POST /shift/absent — mark an assigned intern absent (spec 6.2). The user
// stays in the slot's userIds; the mark is recorded per-person and mirrored
// into attendance (unless an admin/resident explicitly marked present).
export async function markAbsent(db: Db, input: AbsentInput, actingUserId: ObjectId): Promise<ShiftAssignment> {
  const { date, roleSlotDefinitionId, userId, absentReason } = input;
  if (!date || !isValidObjectId(roleSlotDefinitionId) || !isValidObjectId(userId)) {
    throw new HttpError(400, "date, roleSlotDefinitionId and userId are required");
  }
  if (typeof absentReason !== "string" || !absentReason.trim()) {
    throw new HttpError(400, "absentReason is required");
  }
  const range = dayRange(date);
  if (!range) throw new HttpError(400, "Invalid date");

  const assignment = await rosterRepo.findAssignmentForSlot(db, range.start, range.end, roleSlotDefinitionId);
  if (!assignment) throw new HttpError(404, "Shift slot not found");
  if (!(assignment.userIds || []).map((u) => u.toString()).includes(userId)) {
    throw new HttpError(400, "User is not assigned to this slot");
  }
  const user = await rosterRepo.findUserById(db, userId, { fullName: 1 });
  if (!user) throw new HttpError(404, "User not found");

  const now = new Date();
  const absent = (assignment.absent || []).filter((e) => e.userId.toString() !== userId);
  absent.push({ userId: toObjectId(userId), absentReason: absentReason.trim(), absentMarkedBy: actingUserId, absentMarkedAt: now });
  await rosterRepo.setAssignmentAbsent(db, assignment._id!, absent);

  const day = range.start;
  const existingAttendance = await rosterRepo.findAttendance(db, userId, day);
  if (!existingAttendance || existingAttendance.status !== "present") {
    await rosterRepo.upsertAttendance(
      db,
      userId,
      day,
      {
        userId: toObjectId(userId),
        date: day,
        status: "absent",
        note: `Absent — ${absentReason.trim()}`,
        markedBy: actingUserId,
        updatedAt: now,
      },
      { createdAt: now }
    );
  }

  await logAudit({
    collection: "shiftAssignments",
    documentId: assignment._id!,
    action: "update",
    summary: `Marked ${user.fullName} absent on ${range.start.toISOString().slice(0, 10)} (${absentReason.trim()})`,
    performedBy: actingUserId,
  });

  const updated = await rosterRepo.findAssignmentById(db, assignment._id!);
  if (!updated) throw new HttpError(404, "Shift slot not found");
  return updated;
}

// DELETE /shift/absent — clear an absence mark. Never touches attendance.
export async function clearAbsent(
  db: Db,
  input: Omit<AbsentInput, "absentReason">,
  actingUserId: ObjectId
): Promise<ShiftAssignment> {
  const { date, roleSlotDefinitionId, userId } = input;
  if (!date || !isValidObjectId(roleSlotDefinitionId) || !isValidObjectId(userId)) {
    throw new HttpError(400, "date, roleSlotDefinitionId and userId are required");
  }
  const range = dayRange(date);
  if (!range) throw new HttpError(400, "Invalid date");

  const assignment = await rosterRepo.findAssignmentForSlot(db, range.start, range.end, roleSlotDefinitionId);
  if (!assignment) throw new HttpError(404, "Shift slot not found");

  const removed = (assignment.absent || []).find((e) => e.userId.toString() === userId);
  if (!removed) return assignment;

  await rosterRepo.pullAssignmentAbsent(db, assignment._id!, toObjectId(userId));

  const user = await rosterRepo.findUserById(db, userId, { fullName: 1 });
  await logAudit({
    collection: "shiftAssignments",
    documentId: assignment._id!,
    action: "update",
    summary: `Cleared absence mark for ${user?.fullName || "user"} on ${range.start.toISOString().slice(0, 10)}`,
    performedBy: actingUserId,
  });

  const updated = await rosterRepo.findAssignmentById(db, assignment._id!);
  if (!updated) throw new HttpError(404, "Shift slot not found");
  return updated;
}

// POST /shift/self-book (spec 6.1: "free-for-all booking"). Server enforces the
// intern toggles only THEMSELVES, only on intern slots, only within [today,
// today + 56d], the slot actually runs that day, and at most one slot per day.
export async function selfBook(
  db: Db,
  input: { date: string; roleSlotDefinitionId: string },
  user: AuthUser
): Promise<{ doc: ShiftAssignment; status: number }> {
  const { date, roleSlotDefinitionId } = input;
  if (!date || !roleSlotDefinitionId) {
    throw new HttpError(400, "date and roleSlotDefinitionId are required");
  }
  if (!isValidObjectId(roleSlotDefinitionId)) throw new HttpError(400, "Invalid roleSlotDefinitionId");

  const range = dayRange(date);
  if (!range) throw new HttpError(400, "Invalid date");
  const start = range.start;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + 56);
  if (start < today || start > horizon) {
    throw new HttpError(400, "You can only book within the next 8 weeks");
  }

  const slot = await rosterRepo.findRoleSlotById(db, roleSlotDefinitionId);
  if (!slot) throw new HttpError(404, "Slot not found");
  if (slot.personType !== "intern") {
    throw new HttpError(403, "This slot is not open for intern self-booking");
  }

  // The slot must actually run that day — same day-type + weekdays rules
  // bulk-generate applies.
  const resolved = await resolveDayType(start);
  if (slot.dayType !== resolved.dayType) {
    throw new HttpError(400, "This slot does not run on that date's day type");
  }
  if (Array.isArray(slot.weekdays) && slot.weekdays.length > 0 && !slot.weekdays.includes(start.getDay())) {
    throw new HttpError(400, "This slot is only bookable on its scheduled weekdays");
  }

  const actingId = toObjectId(user.id);
  const me = actingId.toString();
  const existing = await rosterRepo.findAssignmentForSlot(db, range.start, range.end, roleSlotDefinitionId);
  const current = (existing?.userIds || []).map((u) => u.toString());

  if (!current.includes(me)) {
    const elsewhere = await rosterRepo.findAssignmentWhereUserElsewhere(db, range.start, range.end, actingId);
    if (elsewhere && elsewhere.roleSlotDefinitionId.toString() !== roleSlotDefinitionId) {
      throw new HttpError(409, "You're already booked for a shift on that date — relinquish it first");
    }
  }

  const next = current.includes(me) ? current.filter((x) => x !== me) : [...current, me];
  const fields = { userIds: next.map((id) => toObjectId(id)) };

  if (existing) {
    await rosterRepo.setAssignmentUsers(db, existing._id!, fields);
    await logAudit({
      collection: "shiftAssignments",
      documentId: existing._id!,
      action: "update",
      summary: `Intern self-book on ${date}: ${user.name} ${current.includes(me) ? "relinquished" : "claimed"} slot ${slot.label}`,
      performedBy: actingId,
    });
    const updated = await rosterRepo.findAssignmentById(db, existing._id!);
    if (!updated) throw new HttpError(404, "Shift slot not found");
    return { doc: updated, status: 200 };
  }

  const doc: ShiftAssignment = {
    date: start,
    roleSlotDefinitionId: toObjectId(roleSlotDefinitionId),
    userIds: next.map((id) => toObjectId(id)),
  };
  const res = await rosterRepo.insertAssignment(db, doc);
  await logAudit({
    collection: "shiftAssignments",
    documentId: res.insertedId,
    action: "create",
    summary: `Intern self-book on ${date}: ${user.name} claimed slot ${slot.label}`,
    performedBy: actingId,
  });
  return { doc: { ...doc, _id: res.insertedId }, status: 201 };
}
