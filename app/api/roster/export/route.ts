import { requireRole } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import type { RoleSlotDefinition, ShiftAssignment, EmergencyDayPool, User } from "@/lib/models/types";
import { dateKey } from "@/lib/roster-import";

// GET /api/roster/export?from=YYYY-MM-DD&to=YYYY-MM-DD — regenerate a
// Wardyati-style .xlsx (one row per day, one column per shift slot) from the
// current assignments/pools, for a printable/offline copy (spec 6.1 step 4).
export async function GET(req: Request) {
  const session = await requireRole(["resident", "admin"]);
  if (!session) return Response.json({ error: "Resident or admin only" }, { status: 403 });

  const url = new URL(req.url);
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");

  const from = new Date(fromParam || dateKey(new Date()));
  from.setHours(0, 0, 0, 0);
  const to = new Date(toParam || new Date(from));
  to.setHours(0, 0, 0, 0);
  if (toParam) to.setDate(to.getDate() + 1);
  else to.setDate(to.getDate() + 14);

  const db = await getDb();
  const [slots, assignments, pools, users, calendar] = await Promise.all([
    db.collection<RoleSlotDefinition>("roleSlotDefinitions").find().toArray(),
    db.collection<ShiftAssignment>("shiftAssignments").find({ date: { $gte: from, $lt: to } }).toArray(),
    db.collection<EmergencyDayPool>("emergencyDayPools").find({ date: { $gte: from, $lt: to } }).toArray(),
    db.collection<User>("users").find({}).project({ passwordHash: 0 }).toArray(),
    db.collection("dayTypeCalendar").find({ date: { $gte: from, $lt: to } }).toArray(),
  ]);

  const userMap = new Map(users.map((u) => [u._id!.toString(), u]));
  const userName = (id: string) => {
    const u = userMap.get(id);
    return u ? `${u.fullName}${u.phone ? ` ${u.phone}` : ""}` : "";
  };

  const assignmentByKey = new Map<string, ShiftAssignment>();
  for (const a of assignments) {
    assignmentByKey.set(`${dateKey(new Date(a.date))}:${a.roleSlotDefinitionId.toString()}`, a);
  }
  const poolByKey = new Map<string, EmergencyDayPool>();
  for (const p of pools) {
    poolByKey.set(`${dateKey(new Date(p.date))}:${p.shiftType}`, p);
  }

  const slotFor = (dayType: string, shift: string, category: string) =>
    slots.find((s) => s.dayType === dayType && s.shiftType === shift && s.category === category);

  const columnDefs = [
    { header: "لونج (Long)", get: (d: Date, dayType: string) => cellFor(d, dayType, "long", "none") },
    { header: "نايت (Night)", get: (d: Date, dayType: string) => cellFor(d, dayType, "night", "none") },
    { header: "كلاينك (Clinic)", get: (d: Date, dayType: string) => cellFor(d, dayType, "long", "clinic") },
    { header: "تحضير عنبر (Ward prep)", get: (d: Date, dayType: string) => cellFor(d, dayType, "long", "ward-prep") },
  ];

  function cellFor(d: Date, dayType: string, shift: string, category: string): string {
    const key = dateKey(d);
    if (dayType === "emergency") {
      const pool = poolByKey.get(`${key}:${shift}`);
      return pool ? pool.userIds.map((id) => userName(id.toString())).filter(Boolean).join("\n") : "";
    }
    const slot = slotFor(dayType, shift, category);
    if (!slot) return "";
    const assignment = assignmentByKey.get(`${key}:${slot._id!.toString()}`);
    return assignment ? (assignment.userIds || []).map((id) => userName(id.toString())).filter(Boolean).join("\n") : "";
  }

  const dayTypeMap = new Map(calendar.map((c: any) => [dateKey(new Date(c.date)), (c.dayType as string) || "normal"]));
  const aoa: (string | number)[][] = [["التاريخ (Date)", ...columnDefs.map((c) => c.header)]];

  for (let d = new Date(from); d < to; d.setDate(d.getDate() + 1)) {
    const dayType = dayTypeMap.get(dateKey(d)) || "normal";
    aoa.push([dateKey(d), ...columnDefs.map((c) => c.get(new Date(d), dayType))]);
  }

  const XLSX = await import("xlsx");
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  sheet["!cols"] = [{ wch: 16 }, { wch: 40 }, { wch: 40 }, { wch: 40 }, { wch: 40 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Roster");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

  return new Response(new Uint8Array(buffer as ArrayBuffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="roster-${dateKey(from)}-${dateKey(new Date(new Date(to).getTime() - 86400000))}.xlsx"`,
    },
  });
}
