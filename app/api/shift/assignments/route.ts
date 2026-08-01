import { requireRole } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { ObjectId } from "mongodb";
import { toObjectId } from "@/lib/api";
import type { ShiftAssignment, RoleSlotDefinition } from "@/lib/models/types";

export async function GET(req: Request) {
  const session = await requireRole(["intern", "resident", "admin"]);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const date = url.searchParams.get("date");

  const db = await getDb();
  if (!date) {
    const all = await db.collection<ShiftAssignment>("shiftAssignments").find().sort({ date: 1 }).toArray();
    return Response.json(all);
  }

  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const assignments = await db.collection<ShiftAssignment>("shiftAssignments")
    .find({ date: { $gte: start, $lt: end } })
    .toArray();

  const userIds = [...new Set(assignments.flatMap((a) => (a.userIds || []).map((u) => u.toString())))];
  const users = userIds.length
    ? await db.collection("users").find({ _id: { $in: userIds.map(toObjectId) } }).toArray()
    : [];
  const userMap = new Map(users.map((u: any) => [u._id.toString(), u]));

  const slotIds = [...new Set(assignments.map((a) => a.roleSlotDefinitionId.toString()))];
  const slots = slotIds.length
    ? await db.collection<RoleSlotDefinition>("roleSlotDefinitions").find({ _id: { $in: slotIds.map(toObjectId) } }).toArray()
    : [];
  const slotMap = new Map(slots.map((s) => [s._id!.toString(), s]));

  return Response.json({
    assignments: assignments.map((a) => ({
      ...a,
      slot: slotMap.get(a.roleSlotDefinitionId.toString()) || null,
      users: (a.userIds || []).map((u) => userMap.get(u.toString()) || null).filter(Boolean),
    })),
  });
}

// Assign one or more users to a slot, generate a date range's slots from the
// day-type calendar, or both. POST body shapes:
//   { date, roleSlotDefinitionId, userIds: string[] }  -> replace the group
//   { date, roleSlotDefinitionId, userId: string }     -> toggle one user in/out
//   { from, to }                                       -> bulk generate
export async function POST(req: Request) {
  const session = await requireRole(["resident", "admin"]);
  if (!session) return Response.json({ error: "Resident or admin only" }, { status: 403 });
  const userId = toObjectId((session.user as any).id);

  const body = await req.json();
  const db = await getDb();

  if (body.from && body.to) {
    return await bulkGenerate(body.from, body.to, userId);
  }

  const { date, roleSlotDefinitionId } = body;
  if (!date || !roleSlotDefinitionId) {
    return Response.json({ error: "date and roleSlotDefinitionId are required (or from/to for bulk)" }, { status: 400 });
  }

  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const existing = await db.collection<ShiftAssignment>("shiftAssignments").findOne({
    date: { $gte: start, $lt: end },
    roleSlotDefinitionId: toObjectId(roleSlotDefinitionId),
  });

  const current = (existing?.userIds || []).map((u) => u.toString());

  // Replace with an explicit userIds array, or toggle a single userId.
  let nextUserIds: string[];
  if (Array.isArray(body.userIds)) {
    nextUserIds = body.userIds.filter((x: unknown) => typeof x === "string" && x);
  } else if (typeof body.userId === "string" && body.userId) {
    nextUserIds = current.includes(body.userId)
      ? current.filter((x) => x !== body.userId)
      : [...current, body.userId];
  } else {
    nextUserIds = current;
  }

  const fields: Record<string, unknown> = {
    userIds: nextUserIds.map((id) => toObjectId(id)),
    startTime: body.startTime || null,
    endTime: body.endTime || null,
  };

  if (existing) {
    await db.collection<ShiftAssignment>("shiftAssignments").updateOne({ _id: existing._id }, { $set: fields });
    await logAudit({
      collection: "shiftAssignments",
      documentId: existing._id,
      action: "update",
      summary: `Updated shift slot ${roleSlotDefinitionId} on ${date} (${nextUserIds.length} person(s))`,
      performedBy: userId,
    });
    const updated = await db.collection<ShiftAssignment>("shiftAssignments").findOne({ _id: existing._id });
    return Response.json(updated);
  }

  const doc: ShiftAssignment = {
    date: start,
    roleSlotDefinitionId: toObjectId(roleSlotDefinitionId),
    userIds: nextUserIds.map((id) => toObjectId(id)),
    startTime: body.startTime || null,
    endTime: body.endTime || null,
  };
  const res = await db.collection<ShiftAssignment>("shiftAssignments").insertOne(doc);
  await logAudit({
    collection: "shiftAssignments",
    documentId: res.insertedId,
    action: "create",
    summary: `Assigned slot ${roleSlotDefinitionId} on ${date}`,
    performedBy: userId,
  });
  return Response.json({ ...doc, _id: res.insertedId }, { status: 201 });
}

async function bulkGenerate(from: string, to: string, userId: any) {
  const db = await getDb();
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + 1);

  const dayTypes = await db.collection("dayTypeCalendar").find({ date: { $gte: start, $lt: end } }).toArray();
  const dayTypeMap = new Map(
    dayTypes.map((d: any) => [new Date(d.date).toISOString().slice(0, 10), d])
  );

  const slots = await db.collection<RoleSlotDefinition>("roleSlotDefinitions").find().toArray();
  const slotsByDayType = new Map<string, RoleSlotDefinition[]>();
  for (const s of slots) {
    const list = slotsByDayType.get(s.dayType) || [];
    list.push(s);
    slotsByDayType.set(s.dayType, list);
  }

  const existing = await db.collection<ShiftAssignment>("shiftAssignments")
    .find({ date: { $gte: start, $lt: end } })
    .toArray();
  const existingKeys = new Set(
    existing.map((a) => `${a.date.toISOString().slice(0, 10)}:${a.roleSlotDefinitionId.toString()}`)
  );

  const toInsert: ShiftAssignment[] = [];
  let created = 0;

  for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    const dayType = (dayTypeMap.get(key)?.dayType as string) || "normal";
    const surgeryOverlay = dayTypeMap.get(key)?.surgeryOverlay || false;

    let daySlots = slotsByDayType.get(dayType) || [];
    if (surgeryOverlay) {
      daySlots = [...daySlots, ...(slotsByDayType.get("normal") || []).filter((s) => s.shiftType === "surgery-partial")];
    }

    for (const slot of daySlots) {
      // weekdays restriction (e.g. ward-prep on Fridays only): skip other days.
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
    const res = await db.collection<ShiftAssignment>("shiftAssignments").insertMany(toInsert);
    const firstId = Object.values(res.insertedIds)[0];
    await logAudit({
      collection: "shiftAssignments",
      documentId: firstId,
      action: "create",
      summary: `Bulk-generated ${created} shift slots for ${from} → ${to}`,
      performedBy: userId,
    });
  }

  return Response.json({ from, to, created });
}
