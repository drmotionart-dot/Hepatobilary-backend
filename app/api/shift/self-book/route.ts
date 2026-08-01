import { requireRole, toObjectId, isValidObjectId } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import type { ShiftAssignment, RoleSlotDefinition } from "@/lib/models/types";

// Intern self-booking (spec 6.1: "free-for-all booking" — interns claim open
// slots within the 8-week roster window). Server enforces that a user can only
// toggle THEMSELVES, only on intern slots, only within [today, today + 56d],
// and on at most one slot per day. Everything is audit-logged (spec 7.1).
export async function POST(req: Request) {
  const session = await requireRole(["intern"]);
  if (!session) return Response.json({ error: "Interns only" }, { status: 403 });
  const actingId = toObjectId((session.user as any).id);

  const body = await req.json();
  const { date, roleSlotDefinitionId } = body;
  if (!date || !roleSlotDefinitionId) {
    return Response.json({ error: "date and roleSlotDefinitionId are required" }, { status: 400 });
  }
  if (!isValidObjectId(roleSlotDefinitionId)) {
    return Response.json({ error: "Invalid roleSlotDefinitionId" }, { status: 400 });
  }

  const start = new Date(date);
  if (Number.isNaN(start.getTime())) return Response.json({ error: "Invalid date" }, { status: 400 });
  start.setHours(0, 0, 0, 0);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + 56);
  if (start < today || start > horizon) {
    return Response.json({ error: "You can only book within the next 8 weeks" }, { status: 400 });
  }

  const db = await getDb();
  const slot = await db
    .collection<RoleSlotDefinition>("roleSlotDefinitions")
    .findOne({ _id: toObjectId(roleSlotDefinitionId) });
  if (!slot) return Response.json({ error: "Slot not found" }, { status: 404 });
  if (slot.personType !== "intern") {
    return Response.json({ error: "This slot is not open for intern self-booking" }, { status: 403 });
  }

  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  // The slot must actually run that day: its day type has to match the date's
  // calendar entry (emergency days route through pools, not base slots) and a
  // weekdays restriction (e.g. Friday-only ward prep) must include this day —
  // the same rules bulk-generate applies.
  const dayTypeDoc = await db.collection("dayTypeCalendar").findOne({ date: { $gte: start, $lt: end } });
  const dayType = (dayTypeDoc as any)?.dayType || "normal";
  if (slot.dayType !== dayType) {
    return Response.json({ error: "This slot does not run on that date's day type" }, { status: 400 });
  }
  if (Array.isArray(slot.weekdays) && slot.weekdays.length > 0 && !slot.weekdays.includes(start.getDay())) {
    return Response.json({ error: "This slot is only bookable on its scheduled weekdays" }, { status: 400 });
  }

  const me = actingId.toString();
  const existing = await db.collection<ShiftAssignment>("shiftAssignments").findOne({
    date: { $gte: start, $lt: end },
    roleSlotDefinitionId: toObjectId(roleSlotDefinitionId),
  });
  const current = (existing?.userIds || []).map((u) => u.toString());

  // If they are claiming a NEW slot, make sure they aren't already on another
  // shift that day (one slot per day rule).
  if (!current.includes(me)) {
    const elsewhere = await db
      .collection<ShiftAssignment>("shiftAssignments")
      .findOne({ date: { $gte: start, $lt: end }, userIds: actingId });
    if (elsewhere && elsewhere.roleSlotDefinitionId.toString() !== roleSlotDefinitionId) {
      return Response.json({ error: "You're already booked for a shift on that date — relinquish it first" }, { status: 409 });
    }
  }

  const next = current.includes(me) ? current.filter((x) => x !== me) : [...current, me];
  const fields = { userIds: next.map((id) => toObjectId(id)) };

  if (existing) {
    await db.collection<ShiftAssignment>("shiftAssignments").updateOne({ _id: existing._id }, { $set: fields });
    await logAudit({
      collection: "shiftAssignments",
      documentId: existing._id,
      action: "update",
      summary: `Intern self-book on ${date}: ${session.user.name} ${current.includes(me) ? "relinquished" : "claimed"} slot ${slot.label}`,
      performedBy: actingId,
    });
    const updated = await db.collection<ShiftAssignment>("shiftAssignments").findOne({ _id: existing._id });
    return Response.json(updated);
  }

  const doc: ShiftAssignment = {
    date: start,
    roleSlotDefinitionId: toObjectId(roleSlotDefinitionId),
    userIds: next.map((id) => toObjectId(id)),
  };
  const res = await db.collection<ShiftAssignment>("shiftAssignments").insertOne(doc);
  await logAudit({
    collection: "shiftAssignments",
    documentId: res.insertedId,
    action: "create",
    summary: `Intern self-book on ${date}: ${session.user.name} claimed slot ${slot.label}`,
    performedBy: actingId,
  });
  return Response.json({ ...doc, _id: res.insertedId }, { status: 201 });
}
