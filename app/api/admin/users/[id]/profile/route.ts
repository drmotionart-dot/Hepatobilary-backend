import { requireRole, toObjectId, isValidObjectId } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { resolveDayTypes } from "@/lib/day-type";
import type { User, ShiftAssignment, RoleSlotDefinition, Attendance, AuditLog } from "@/lib/models/types";

// GET /api/admin/users/[id]/profile — the intern profile bundle (spec 11.8):
// full account data, complete roster/shift history, attendance record, and the
// user's audit-log entries. Admin or resident.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const session = await requireRole(["admin", "resident"]);
  if (!session) return Response.json({ error: "Admin or resident only" }, { status: 403 });

  const db = await getDb();
  if (!isValidObjectId(params.id)) return Response.json({ error: "Invalid user id" }, { status: 400 });
  const userId = toObjectId(params.id);

  const user = await db
    .collection<User>("users")
    .findOne({ _id: userId }, { projection: { passwordHash: 0 } });
  if (!user) return Response.json({ error: "User not found" }, { status: 404 });

  // Roster/shift history: every assignment the user is in, joined with the slot
  // definition and the resolved day type (stored calendar first, weekday default
  // otherwise). Dates live at UTC midnight — normalize before grouping.
  const assignments = await db
    .collection<ShiftAssignment>("shiftAssignments")
    .find({ userIds: userId })
    .sort({ date: -1 })
    .toArray();
  const slotIds = assignments.map((a) => a.roleSlotDefinitionId);
  const slots =
    slotIds.length > 0
      ? await db
          .collection<RoleSlotDefinition>("roleSlotDefinitions")
          .find({ _id: { $in: slotIds } })
          .toArray()
      : [];
  const slotById = new Map(slots.map((s) => [s._id!.toString(), s]));

  const rosterHistory = assignments.map((a) => {
    const slot = slotById.get(a.roleSlotDefinitionId.toString());
    return {
      date: a.date,
      label: slot?.label ?? "Unknown slot",
      dayType: slot?.dayType ?? null,
      shiftType: slot?.shiftType ?? null,
      category: slot?.category ?? null,
      startTime: a.startTime ?? null,
      endTime: a.endTime ?? null,
    };
  });

  const resolvedMap = new Map<string, string>();
  for (const r of await resolveDayTypes(assignments.map((a) => a.date))) {
    resolvedMap.set(r.date.toISOString(), r.dayType);
  }

  // Attendance record (spec 11.8) including marked-absent entries.
  const attendance = await db
    .collection<Attendance>("attendance")
    .find({ userId })
    .sort({ date: -1 })
    .toArray();

  // The user's audit-log entries (their performedBy trail), newest first.
  const auditEntriesRaw = await db
    .collection<AuditLog>("auditLogs")
    .find({ performedBy: userId })
    .sort({ performedAt: -1 })
    .limit(100)
    .toArray();

  return Response.json({
    user,
    rosterHistory: rosterHistory.map((r) => ({ ...r, resolvedDayType: resolvedMap.get(r.date.toISOString()) ?? null })),
    attendance,
    auditEntries: auditEntriesRaw,
  });
}
