// Roster read/compose + import business rules (spec §6, spec 16.1): the 8-week
// board, the "on shift now" view, the Wardyati-style export, the .xlsx import
// (spec 6.1) and its review queue (bind / ignore / create account, spec 6.1
// step 4). Routes stay thin — the service owns the loops, counters and audit
// entries. Pure parsing helpers stay in lib/roster-import.ts.

import type { Db, ObjectId } from "mongodb";
import type { RosterImport, RosterImportRow, ShiftAssignment } from "@/lib/models/types";
import { isValidObjectId, toObjectId } from "@/lib/api";
import { HttpError } from "@/lib/http";
import { logAudit } from "@/lib/audit";
import { resolveDayType, resolveDayTypes } from "@/lib/day-type";
import { activeShiftDate } from "@/lib/shift";
import { rosterRepo } from "@/lib/repositories/rosterRepo";
import { joinAssignments } from "@/lib/services/shiftService";
import { createBulkAccount } from "@/lib/account-factory";
import {
  buildColumnMap,
  classifyColumn,
  dateKey,
  findHeaderRow,
  firstDateCell,
  matchUser,
  normalizeName,
  normalizePhone,
  parseDateCell,
  parseEntryLines,
  slotKey,
  slotKeyByCategory,
  targetCategoryLabel,
} from "@/lib/roster-import";

// GET /roster/board — the 8-week roster window in one call: active users, the
// slot rulebook, assignments, day-type calendar and emergency pools (spec 6.1).
export async function getBoard(db: Db) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setDate(end.getDate() + 56);

  const [users, slots, assignments, calendar, pools] = await Promise.all([
    rosterRepo.findActiveUsers(db, { passwordHash: 0 }, { fullName: 1 }),
    rosterRepo.findRoleSlots(db),
    rosterRepo.findAssignmentsBetween(db, today, end),
    rosterRepo.findDayTypes(db, { date: { $gte: today, $lt: end } }),
    rosterRepo.findEmergencyPools(db, { date: { $gte: today, $lt: end } }),
  ]);

  return { users, slots, assignments, calendar, pools };
}

// GET /roster/today — who is on shift now (spec section 7): resolve the active
// shift's day type, then return that day's assignments grouped by shift window.
// Uses the same 08:00 → 08:00 boundary as the dashboard.
export async function getToday(db: Db) {
  const startOfDay = activeShiftDate();
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);

  const resolved = await resolveDayType(startOfDay);
  const assignments = await rosterRepo.findAssignmentsBetween(db, startOfDay, endOfDay);

  return {
    dayType: resolved.dayType,
    surgeryOverlay: resolved.surgeryOverlay,
    assignments: await joinAssignments(db, assignments),
  };
}

// GET /roster/export?from=…&to=… — build the Wardyati-style grid (one row per
// day, one column per shift slot) as an array-of-arrays. The route turns the
// aoa into the .xlsx buffer; resolving the range + cells is pure data here.
export async function buildRosterExport(db: Db, fromParam: string | null, toParam: string | null) {
  const from = new Date(fromParam || dateKey(new Date()));
  if (Number.isNaN(from.getTime())) throw new HttpError(400, "Invalid from date");
  from.setHours(0, 0, 0, 0);
  const to = new Date(toParam || new Date(from));
  if (Number.isNaN(to.getTime())) throw new HttpError(400, "Invalid to date");
  to.setHours(0, 0, 0, 0);
  if (toParam) to.setDate(to.getDate() + 1);
  else to.setDate(to.getDate() + 14);

  const [slots, assignments, pools, users] = await Promise.all([
    rosterRepo.findRoleSlots(db),
    rosterRepo.findAssignmentsBetween(db, from, to),
    rosterRepo.findEmergencyPools(db, { date: { $gte: from, $lt: to } }),
    rosterRepo.findAllUsers(db, { passwordHash: 0 }),
  ]);

  const resolvedDays = await resolveDayTypes(
    Array.from({ length: Math.ceil((to.getTime() - from.getTime()) / 86400000) }, (_, i) => {
      const d = new Date(from);
      d.setDate(d.getDate() + i);
      return d;
    })
  );
  const dayTypeMap = new Map(resolvedDays.map((r) => [dateKey(r.date), r.dayType]));

  const userMap = new Map(users.map((u) => [u._id!.toString(), u]));
  const userName = (id: string) => {
    const u = userMap.get(id);
    return u ? `${u.fullName}${u.phone ? ` ${u.phone}` : ""}` : "";
  };

  const assignmentByKey = new Map<string, ShiftAssignment>();
  for (const a of assignments) {
    assignmentByKey.set(`${dateKey(new Date(a.date))}:${a.roleSlotDefinitionId.toString()}`, a);
  }
  const poolByKey = new Map<string, { userIds: ObjectId[] }>();
  for (const p of pools) {
    poolByKey.set(`${dateKey(new Date(p.date))}:${p.shiftType}`, p);
  }

  const slotFor = (dayType: string, shift: string, category: string) =>
    slots.find((s) => s.dayType === dayType && s.shiftType === shift && s.category === category);

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

  const columnDefs = [
    { header: "لونج (Long)", get: (d: Date, dayType: string) => cellFor(d, dayType, "long", "none") },
    { header: "نايت (Night)", get: (d: Date, dayType: string) => cellFor(d, dayType, "night", "none") },
    { header: "كلاينك (Clinic)", get: (d: Date, dayType: string) => cellFor(d, dayType, "long", "clinic") },
    { header: "تحضير عنبر (Ward prep)", get: (d: Date, dayType: string) => cellFor(d, dayType, "long", "ward-prep") },
  ];

  const aoa: (string | number)[][] = [["التاريخ (Date)", ...columnDefs.map((c) => c.header)]];
  for (let d = new Date(from); d < to; d.setDate(d.getDate() + 1)) {
    const dayType = dayTypeMap.get(dateKey(d)) || "normal";
    aoa.push([dateKey(d), ...columnDefs.map((c) => c.get(new Date(d), dayType))]);
  }

  return { aoa, from, to };
}

export interface RosterImportResult {
  sourceFileName: string;
  importId: ObjectId;
  summary: {
    days: number;
    rowsSkipped: number;
    peopleFound: number;
    peopleMatched: number;
    peopleUnmatched: number;
    assignmentsCreated: number;
    assignmentsUpdated: number;
    poolsCreated: number;
    poolsUpdated: number;
  };
  unrecognizedColumns: string[];
  unmatched: RosterImportRow[];
}

// POST /roster/import — fill the matching ShiftAssignment slots / EmergencyDay
// pools from the parsed Wardyati sheet (one row per day, cells = bulleted
// "name + phone" entries). Matches by phone (primary) then name (fallback).
export async function processRosterImport(
  db: Db,
  fileName: string,
  aoa: unknown[][],
  importerId: ObjectId
): Promise<RosterImportResult> {
  const { headerRow, dataStartRow } = findHeaderRow(aoa);
  const columnMap = buildColumnMap(headerRow);
  const unrecognizedColumns = headerRow
    ? headerRow.slice(1).filter((h) => h && classifyColumn(h).shift === null && classifyColumn(h).category === "none").map(String)
    : [];

  const users = await rosterRepo.findActiveUsers(db);
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

  const slots = await rosterRepo.findRoleSlots(db);

  const parsedRows: { date: Date; rowIndex: number }[] = [];
  aoa.slice(dataStartRow).forEach((row, idx) => {
    const cell = firstDateCell(row);
    if (cell) parsedRows.push({ date: cell.date, rowIndex: idx + dataStartRow });
  });

  const dateRange = parsedRows.length
    ? { from: new Date(parsedRows[0].date), to: new Date(parsedRows[parsedRows.length - 1].date) }
    : null;
  if (dateRange) dateRange.to.setDate(dateRange.to.getDate() + 1);

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
              ? null
              : slotKey(slots, dayType, target.shift, "none");

        if (dayType === "emergency") {
          const { value: poolDoc, created: poolNew } = await rosterRepo.upsertPoolUser(
            db,
            date,
            (target.shift as string) || "long",
            userId ? toObjectId(userId) : null,
            importerId
          );
          if (poolNew) poolsCreated++;
          else if (userId) poolsUpdated++;
          if (poolDoc) {
            void logAudit({
              collection: "emergencyDayPools",
              documentId: poolDoc._id!,
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
            const r: RosterImportRow = { date: dateKey(date), target: targetCategoryLabel(target), name: entry.name, phone: entry.phone, matchedUserId: null, status: "unmatched" };
            rows.push(r);
            unmatched.push(r);
            continue;
          }
          const { value: assignDoc, created: assignNew } = await rosterRepo.upsertAssignmentUser(
            db,
            date,
            targetKey,
            userId ? toObjectId(userId) : null
          );
          if (assignNew) assignmentsCreated++;
          else if (userId) assignmentsUpdated++;
          if (assignDoc) {
            void logAudit({
              collection: "shiftAssignments",
              documentId: assignDoc._id!,
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
    sourceFileName: fileName,
    rows,
  };
  const impRes = await rosterRepo.insertRosterImport(db, importDoc);

  await logAudit({
    collection: "rosterImports",
    documentId: impRes.insertedId,
    action: "create",
    summary: `Roster import "${fileName}": ${peopleMatched}/${peopleFound} people matched, ${assignmentsCreated} assignments created, ${poolsCreated} pools created`,
    performedBy: importerId,
  });

  return {
    sourceFileName: fileName,
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
  };
}

// GET /roster/import/review — unmatched entries across the latest imports plus
// the active users they can be bound to.
export async function listReviewQueue(db: Db) {
  const [imports, users] = await Promise.all([
    rosterRepo.findImportsWithUnmatched(db, 5),
    rosterRepo.findActiveUsers(db, { passwordHash: 0 }, { fullName: 1 }),
  ]);

  return {
    users: users.map((u) => ({ _id: u._id, fullName: u.fullName, role: u.role, phone: u.phone })),
    imports: imports.map((imp) => ({
      _id: imp._id,
      sourceFileName: imp.sourceFileName,
      uploadedAt: imp.uploadedAt,
      rows: imp.rows.map((r, idx) => ({ rowIndex: idx, ...r })).filter((r) => r.status === "unmatched"),
    })),
  };
}

export interface ReviewRowInput {
  importId: string;
  rowIndex?: unknown;
  userId?: string;
  ignore?: boolean;
}

// POST /roster/import/review — bind an unmatched row to an existing account or
// mark it ignored.
export async function resolveReviewRow(db: Db, input: ReviewRowInput, actorId: ObjectId): Promise<{ ok: true }> {
  const { importId, rowIndex, userId: assigneeId, ignore } = input;

  if (!importId || !isValidObjectId(importId)) throw new HttpError(400, "importId is required");
  const imp = await rosterRepo.findRosterImportById(db, importId);
  if (!imp) throw new HttpError(404, "Import not found");

  if (typeof rowIndex !== "number") {
    throw new HttpError(400, "importId and rowIndex are required");
  }
  if (rowIndex < 0 || rowIndex >= imp.rows.length) {
    throw new HttpError(400, "Row index out of range");
  }

  const row = imp.rows[rowIndex];
  if (row.status !== "unmatched") {
    throw new HttpError(400, "Row already resolved");
  }

  if (ignore) {
    await rosterRepo.updateRosterImport(db, imp._id!, { [`rows.${rowIndex}.status`]: "ignored" });
    await logAudit({
      collection: "rosterImports",
      documentId: imp._id!,
      action: "update",
      summary: `Ignored unmatched roster entry "${row.name}" (${row.target})`,
      performedBy: actorId,
    });
    return { ok: true };
  }

  if (!assigneeId || !isValidObjectId(assigneeId)) {
    throw new HttpError(400, "userId, ignore, or create action is required");
  }

  if (!(await bindToTarget(db, row, toObjectId(assigneeId), actorId))) {
    throw new HttpError(400, "Row has no valid target or date");
  }

  await rosterRepo.updateRosterImport(db, imp._id!, {
    [`rows.${rowIndex}.status`]: "created",
    [`rows.${rowIndex}.matchedUserId`]: assigneeId,
  });
  await logAudit({
    collection: "rosterImports",
    documentId: imp._id!,
    action: "update",
    summary: `Matched roster entry "${row.name}" (${row.target}) to ${assigneeId}`,
    performedBy: actorId,
  });

  return { ok: true };
}

// POST /roster/import/review { action: "create-account" } — create one account
// for a single unmatched row and bind it to its slot/pool.
export async function createOneAccount(db: Db, importId: string, rowIndex: unknown, actorId: ObjectId) {
  if (!importId || !isValidObjectId(importId)) throw new HttpError(400, "importId is required");
  const imp = await rosterRepo.findRosterImportById(db, importId);
  if (!imp) throw new HttpError(404, "Import not found");
  if (typeof rowIndex !== "number") throw new HttpError(400, "rowIndex is required");
  if (rowIndex < 0 || rowIndex >= imp.rows.length) throw new HttpError(400, "Row index out of range");

  const row = imp.rows[rowIndex];
  if (row.status !== "unmatched") throw new HttpError(400, "Row already resolved");

  const result = await createAccountForRow(db, imp, rowIndex, actorId, new Set<string>());
  if (result.skippedReason) {
    throw new HttpError(400, `Cannot create account: ${result.skippedReason}`, { rowIndex });
  }

  await logAudit({
    collection: "users",
    documentId: toObjectId(result.userId)!,
    action: "create",
    summary: `Created account for unmatched roster entry "${row.name}" (${row.phone}) from "${imp.sourceFileName}"`,
    performedBy: actorId,
  });

  return {
    ok: true,
    account: {
      name: result.account!.name,
      loginId: result.account!.loginId,
      password: result.account!.password,
    },
  };
}

// POST /roster/import/review { action: "create-all" } — create accounts for
// every still-unmatched row with a phone across all review imports, and bind
// everyone into their slot.
export async function createAllAccounts(db: Db, actorId: ObjectId) {
  const imports = await rosterRepo.findImportsWithUnmatched(db, 5);

  const usedLoginIds = new Set<string>();
  const created: { name: string; loginId: string; password: string }[] = [];
  const skipped: { name: string; reason: string }[] = [];
  let matchedExisting = 0;

  for (const imp of imports) {
    for (let i = 0; i < imp.rows.length; i++) {
      const row = imp.rows[i];
      if (row.status !== "unmatched") continue;
      const result = await createAccountForRow(db, imp, i, actorId, usedLoginIds);
      if (result.skippedReason) {
        skipped.push({ name: row.name, reason: result.skippedReason });
      } else if (result.account) {
        created.push(result.account);
      } else {
        matchedExisting++;
      }
    }
  }

  const remainingDocs = await rosterRepo.findAnyImportWithUnmatched(db);
  const remaining = remainingDocs ? remainingDocs.rows.filter((r) => r.status === "unmatched").length : 0;

  await logAudit({
    collection: "rosterImports",
    documentId: imports[0]?._id!,
    action: "update",
    summary: `Create accounts for unmatched roster entries: ${created.length} created, ${matchedExisting} matched existing, ${skipped.length} skipped`,
    performedBy: actorId,
  });

  return { ok: true, created, matchedExisting, skipped, remaining };
}

// ---- review queue: account creation + binding ----

// Creates (or reuses) an account for one unmatched row and binds it to its
// target. Returns the generated credentials (or null when the phone already had
// an account — the person was just bound). Persists row status + credentials.
async function createAccountForRow(
  db: Db,
  imp: RosterImport,
  rowIndex: number,
  actorId: ObjectId,
  usedLoginIds: Set<string>
): Promise<{ account: { name: string; loginId: string; password: string } | null; userId: string; skippedReason: string | null }> {
  const row = imp.rows[rowIndex];
  if (!row.phone) return { account: null, userId: "", skippedReason: "no phone — match manually" };

  const result = await createBulkAccount(db, {
    fullName: row.name,
    phone: row.phone,
    role: "intern",
    rotationImportId: imp._id,
    approvedBy: actorId,
    usedLoginIds,
  });

  const userId = result.user._id!.toString();
  const ok = await bindToTarget(db, row, toObjectId(userId), actorId);
  if (!ok) return { account: null, userId: "", skippedReason: "row has no valid target or date" };

  const set: Record<string, unknown> = {
    [`rows.${rowIndex}.status`]: result.status === "created" ? "created" : "matched-existing",
    [`rows.${rowIndex}.matchedUserId`]: userId,
  };
  if (result.status === "created") {
    set[`rows.${rowIndex}.generatedLoginId`] = result.loginId;
    set[`rows.${rowIndex}.generatedPassword`] = result.password;
  }
  await rosterRepo.updateRosterImport(db, imp._id!, set);

  return {
    account: result.status === "created" ? { name: row.name, loginId: result.loginId, password: result.password } : null,
    userId,
    skippedReason: null,
  };
}

// Assign a user into the row's ShiftAssignment slot or EmergencyDayPool. Every
// target write is audit-logged on its own collection (spec 7.1).
async function bindToTarget(db: Db, row: RosterImportRow, assigneeId: ObjectId, actorId: ObjectId): Promise<boolean> {
  const date = parseDateCell(row.date);
  if (!date) return false;
  const localDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (row.target.startsWith("pool:")) {
    const shiftType = row.target.slice("pool:".length);
    const { value: poolDoc, created: poolNew } = await rosterRepo.upsertPoolUser(db, localDate, shiftType, assigneeId, actorId);
    if (poolDoc) {
      void logAudit({
        collection: "emergencyDayPools",
        documentId: poolDoc._id!,
        action: poolNew ? "create" : "update",
        summary: `Bound ${assigneeId} to ${shiftType} pool on ${row.date}`,
        performedBy: actorId,
      });
    }
    return true;
  }
  if (row.target.startsWith("slot:")) {
    const slotId = row.target.slice("slot:".length);
    if (!isValidObjectId(slotId)) return false;
    const { value: assignDoc, created: assignNew } = await rosterRepo.upsertAssignmentUser(db, localDate, toObjectId(slotId), assigneeId);
    if (assignDoc) {
      void logAudit({
        collection: "shiftAssignments",
        documentId: assignDoc._id!,
        action: assignNew ? "create" : "update",
        summary: `Bound ${assigneeId} to slot ${slotId} on ${row.date}`,
        performedBy: actorId,
      });
    }
    return true;
  }
  return false;
}
