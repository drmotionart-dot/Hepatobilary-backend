import { requireRole } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { toObjectId } from "@/lib/api";
import { resolveDayTypes } from "@/lib/day-type";
import type { RosterImport, RosterImportRow, RoleSlotDefinition, User } from "@/lib/models/types";
import {
  classifyColumn,
  dateKey,
  normalizeName,
  normalizePhone,
  parseDateCell,
  parseEntryLines,
  type ColumnTarget,
} from "@/lib/roster-import";

// POST /api/roster/import — upload a Wardyati rotation .xlsx (one row per day,
// one column per shift slot, cells = bulleted "name + phone" entries). Matches
// people by phone (primary) or name (fallback), then fills the matching
// ShiftAssignment slots / EmergencyDayPools for each date (spec 6.1).
export async function POST(req: Request) {
  const session = await requireRole(["resident", "admin"]);
  if (!session) return Response.json({ error: "Resident or admin only" }, { status: 403 });
  const importerId = toObjectId((session.user as any).id);

  const formData = await req.formData();
  const file = formData.get("file") as File;
  if (!file) return Response.json({ error: "No file provided" }, { status: 400 });

  const XLSX = await import("xlsx");
  const buffer = Buffer.from(await file.arrayBuffer());
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });

  const { headerRow, dataStartRow } = findHeaderRow(aoa);
  const columnMap = buildColumnMap(headerRow);
  const unrecognizedColumns = headerRow
    ? headerRow.slice(1).filter((h) => h && classifyColumn(h).shift === null && classifyColumn(h).category === "none").map(String)
    : [];

  const db = await getDb();
  const users = await db.collection<User>("users").find({ status: "active" }).toArray();
  const phoneMap = new Map<string, string>();
  const nameMap = new Map<string, string>();
  for (const u of users) {
    const id = u._id!.toString();
    if (u.phone) {
      const key = normalizePhone(u.phone);
      if (key && !phoneMap.has(key)) phoneMap.set(key, id);
    }
    const nk = normalizeName(u.fullName);
    if (nk && !nameMap.has(nk)) nameMap.set(nk, id);
  }

  const slots = await db.collection<RoleSlotDefinition>("roleSlotDefinitions").find().toArray();

  // Local-midnight dates (matching how the rest of the roster stores dates).
  const parsedRows: { date: Date; rowIndex: number }[] = [];
  aoa.slice(dataStartRow).forEach((row, idx) => {
    const cell = firstDateCell(row);
    if (cell) parsedRows.push({ date: cell.date, rowIndex: idx + dataStartRow });
  });

  const dateRange = parsedRows.length
    ? { from: new Date(parsedRows[0].date), to: new Date(parsedRows[parsedRows.length - 1].date) }
    : null;
  if (dateRange) dateRange.to.setDate(dateRange.to.getDate() + 1);

  // Resolved day type per date across the sheet's range (stored calendar wins,
  // weekday default otherwise — Thursday→clinic, Sun/Wed→normal+surgeryOverlay).
  let dayTypeMap = new Map<string, string>();
  if (dateRange) {
    const dates = Array.from(
      { length: Math.ceil((dateRange.to.getTime() - dateRange.from.getTime()) / 86400000) },
      (_, i) => {
        const d = new Date(dateRange.from);
        d.setDate(d.getDate() + i);
        return d;
      }
    );
    dayTypeMap = new Map((await resolveDayTypes(dates)).map((r) => [dateKey(r.date), r.dayType]));
  }

  const rows: RosterImportRow[] = [];
  const unmatched: RosterImportRow[] = [];
  let peopleFound = 0;
  let peopleMatched = 0;
  let assignmentsCreated = 0;
  let assignmentsUpdated = 0;
  let poolsCreated = 0;
  let poolsUpdated = 0;
  let rowsSkipped = 0;

  const now = new Date();

  for (const { date: parsed, rowIndex } of parsedRows) {
    const row = aoa[rowIndex];
    const date = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
    const dayType = dayTypeMap.get(dateKey(date)) || "normal";

    for (const { col, target } of columnMap) {
      const entries = parseEntryLines(row[col]);
      for (const entry of entries) {
        peopleFound++;
        const userId = matchUser(entry.name, entry.phone, phoneMap, nameMap);

        const targetKey = target.category === "ward-prep"
          ? slotKeyByCategory(slots, "ward-prep")
          : target.category === "clinic"
            ? slotKey(slots, dayType, target.shift, "clinic")
            : dayType === "emergency"
              ? null // emergency days go to the pool, not a base Long/Night slot
              : slotKey(slots, dayType, target.shift, "none");

        if (dayType === "emergency") {
          const res = await db.collection("emergencyDayPools").findOneAndUpdate(
            { date, shiftType: target.shift },
            {
              $setOnInsert: { date, shiftType: target.shift, createdBy: importerId, createdAt: now },
              $addToSet: userId ? { userIds: toObjectId(userId) } : {},
            },
            { upsert: true, includeResultMetadata: true }
          );
          const poolDoc = res.value;
          const poolNew = Boolean(res.lastErrorObject?.upserted);
          if (poolNew) poolsCreated++;
          else if (userId) poolsUpdated++;
          if (poolDoc) {
            void logAudit({
              collection: "emergencyDayPools",
              documentId: poolDoc._id,
              action: poolNew ? "create" : "update",
              summary: `Roster import ${poolNew ? "created" : "updated"} ${target.shift} pool on ${dateKey(date)}${userId ? ` — ${entry.name}` : ""}`,
              performedBy: importerId,
            });
          }
          rows.push({
            date: dateKey(date),
            target: `pool:${target.shift}`,
            name: entry.name,
            phone: entry.phone,
            matchedUserId: userId || null,
            status: userId ? "created" : "unmatched",
          });
        } else {
          if (!targetKey) {
            rows.push({ date: dateKey(date), target: targetCategoryLabel(target), name: entry.name, phone: entry.phone, matchedUserId: null, status: "unmatched" });
            unmatched.push(rows[rows.length - 1]);
            continue;
          }
          const res = await db.collection("shiftAssignments").findOneAndUpdate(
            { date, roleSlotDefinitionId: targetKey },
            {
              $setOnInsert: { date, roleSlotDefinitionId: targetKey },
              $addToSet: userId ? { userIds: toObjectId(userId) } : {},
            },
            { upsert: true, includeResultMetadata: true }
          );
          const assignDoc = res.value;
          const assignNew = Boolean(res.lastErrorObject?.upserted);
          if (assignNew) assignmentsCreated++;
          else if (userId) assignmentsUpdated++;
          if (assignDoc) {
            void logAudit({
              collection: "shiftAssignments",
              documentId: assignDoc._id,
              action: assignNew ? "create" : "update",
              summary: `Roster import ${assignNew ? "created" : "updated"} slot ${targetKey} on ${dateKey(date)}${userId ? ` — ${entry.name}` : ""}`,
              performedBy: importerId,
            });
          }
          rows.push({
            date: dateKey(date),
            target: `slot:${targetKey.toString()}`,
            name: entry.name,
            phone: entry.phone,
            matchedUserId: userId || null,
            status: userId ? "created" : "unmatched",
          });
        }

        if (userId) peopleMatched++;
        else unmatched.push(rows[rows.length - 1]);
      }
    }
    if (columnMap.every(({ col }) => !row[col] || String(row[col]).trim() === "")) rowsSkipped++;
  }

  const importDoc: RosterImport = {
    uploadedBy: importerId,
    uploadedAt: now,
    sourceFileName: file.name,
    rows,
  };
  const impRes = await db.collection<RosterImport>("rosterImports").insertOne(importDoc);

  await logAudit({
    collection: "rosterImports",
    documentId: impRes.insertedId,
    action: "create",
    summary: `Roster import "${file.name}": ${peopleMatched}/${peopleFound} people matched, ${assignmentsCreated} assignments created, ${poolsCreated} pools created`,
    performedBy: importerId,
  });

  return Response.json({
    sourceFileName: file.name,
    importId: impRes.insertedId,
    summary: {
      days: parsedRows.length,
      rowsSkipped,
      peopleFound,
      peopleMatched,
      peopleUnmatched: peopleFound - peopleMatched,
      assignmentsCreated,
      assignmentsUpdated,
      poolsCreated,
      poolsUpdated,
    },
    unrecognizedColumns,
    unmatched,
  });
}

function findHeaderRow(aoa: unknown[][]): { headerRow: string[] | null; dataStartRow: number } {
  const lookback = Math.min(aoa.length, 6);
  for (let i = 0; i < lookback; i++) {
    const row = aoa[i];
    if (!row || row.every((c) => c == null || String(c).trim() === "")) continue;
    const first = String(row[0] || "").trim();
    const firstIsDate = parseDateCell(row[0]) !== null;
    if (!firstIsDate) {
      const rest = row.slice(1).map((c) => String(c || "").trim()).filter(Boolean);
      const looksLikeHeader = /^(التاريخ|اليوم|date|day)/i.test(first) || rest.some((c) => classifyColumn(c).shift !== null);
      if (looksLikeHeader) {
        return { headerRow: row.map((c) => String(c || "").trim()), dataStartRow: i + 1 };
      }
    }
  }
  return { headerRow: null, dataStartRow: 0 };
}

function buildColumnMap(headerRow: string[] | null): { col: number; target: ColumnTarget }[] {
  if (headerRow) {
    return headerRow
      .slice(1)
      .map((h, i) => ({ col: i + 1, target: classifyColumn(h) }))
      .filter((c) => c.target.shift !== null || c.target.category !== "none");
  }
  // No header row — assume the Wardyati column order: Long, Night, Clinic, Ward prep.
  return [
    { col: 1, target: { shift: "long", category: "none", emergencyRoute: false } },
    { col: 2, target: { shift: "night", category: "none", emergencyRoute: false } },
    { col: 3, target: { shift: "long", category: "clinic", emergencyRoute: false } },
    { col: 4, target: { shift: "long", category: "ward-prep", emergencyRoute: false } },
  ];
}

function firstDateCell(row: unknown[]): { date: Date; index: number } | null {
  for (let i = 0; i < Math.min(row.length, 4); i++) {
    const d = parseDateCell(row[i]);
    if (d) return { date: d, index: i };
  }
  return null;
}

function matchUser(name: string, phone: string, phoneMap: Map<string, string>, nameMap: Map<string, string>): string | null {
  if (phone) {
    const hit = phoneMap.get(normalizePhone(phone));
    if (hit) return hit;
  }
  if (name) {
    const nk = normalizeName(name);
    if (nk) {
      const hit = nameMap.get(nk);
      if (hit) return hit;
    }
  }
  return null;
}

function slotKey(slots: RoleSlotDefinition[], dayType: string, shift: string | null, category: string): any | null {
  if (!shift) return null;
  const exact = slots.find((s) => s.dayType === dayType && s.shiftType === shift && s.category === category);
  if (exact) return exact._id || null;
  return slots.find((s) => s.dayType === dayType && s.shiftType === shift)?. _id || null;
}

function slotKeyByCategory(slots: RoleSlotDefinition[], category: string): any | null {
  return slots.find((s) => s.category === category)?. _id || null;
}

function targetCategoryLabel(target: ColumnTarget): string {
  if (target.category === "ward-prep") return "slot:ward-prep";
  if (target.category === "clinic") return `slot:${target.shift}-clinic`;
  return `slot:${target.shift}`;
}
