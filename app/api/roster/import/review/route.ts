import { requireCapability, toObjectId, isValidObjectId } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import type { Db, ObjectId } from "mongodb";
import type { RosterImport, RosterImportRow } from "@/lib/models/types";
import { dateKey, parseDateCell } from "@/lib/roster-import";
import { createBulkAccount } from "@/lib/account-factory";

// Review queue for the Wardyati roster import, mirroring the lab-import
// "needs review" pattern (spec 6.1 step 2): entries whose phone/name matched
// no known user are listed here so a resident/admin can bind them to an
// existing account, ignore them, or — the key action — create a new account
// on the spot (spec 6.1 step 4). "Create accounts" reuses the exact same
// bulk-account generation as the rotation Excel import (spec 10.2), so a
// person only ever needs one account no matter which import meets them first.
export async function GET() {
  const session = await requireCapability("manage-roster");
  if (!session) return Response.json({ error: "Requires the manage-roster capability" }, { status: 403 });

  const db = await getDb();
  const imports = await db
    .collection<RosterImport>("rosterImports")
    .find({ "rows.status": "unmatched" })
    .sort({ uploadedAt: -1 })
    .limit(5)
    .toArray();

  const users = await db
    .collection("users")
    .find({ status: "active" })
    .project({ passwordHash: 0 })
    .sort({ fullName: 1 })
    .toArray();

  return Response.json({
    users: users.map((u: any) => ({ _id: u._id, fullName: u.fullName, role: u.role, phone: u.phone })),
    imports: imports.map((imp) => ({
      _id: imp._id,
      sourceFileName: imp.sourceFileName,
      uploadedAt: imp.uploadedAt,
      // rowIndex is the index into the FULL stored rows array (rows may also
      // contain already-matched entries), which POST needs to address a row.
      rows: imp.rows
        .map((r, idx) => ({ rowIndex: idx, ...r }))
        .filter((r) => r.status === "unmatched"),
    })),
  });
}

// POST actions on the review queue:
//   { importId, rowIndex, userId }        — bind to an existing account
//   { importId, rowIndex, ignore: true }  — mark skipped
//   { importId, action: "create-account", rowIndex } — create ONE account + bind
//   { importId, action: "create-all" }    — create/bind every unmatched row with a phone
export async function POST(req: Request) {
  const session = await requireCapability("manage-roster");
  if (!session) return Response.json({ error: "Requires the manage-roster capability" }, { status: 403 });
  const actorId = toObjectId((session.user as any).id);

  const body = await req.json();
  const { importId, rowIndex, userId: assigneeId, ignore, action } = body;

  const db = await getDb();

  // "Create accounts for all unmatched" spans every import still in the queue.
  if (action === "create-all") {
    return await createAllAccounts(db, actorId);
  }

  if (!importId || !isValidObjectId(importId)) return Response.json({ error: "importId is required" }, { status: 400 });
  const imp = await db.collection<RosterImport>("rosterImports").findOne({ _id: toObjectId(importId) });
  if (!imp) return Response.json({ error: "Import not found" }, { status: 404 });

  if (action === "create-account") {
    if (typeof rowIndex !== "number") return Response.json({ error: "rowIndex is required" }, { status: 400 });
    return await createOneAccount(db, imp, rowIndex, actorId);
  }

  if (typeof rowIndex !== "number") {
    return Response.json({ error: "importId and rowIndex are required" }, { status: 400 });
  }
  if (rowIndex < 0 || rowIndex >= imp.rows.length) {
    return Response.json({ error: "Row index out of range" }, { status: 400 });
  }

  const row = imp.rows[rowIndex];
  if (row.status !== "unmatched") {
    return Response.json({ error: "Row already resolved" }, { status: 400 });
  }

  if (ignore) {
    await db.collection<RosterImport>("rosterImports").updateOne(
      { _id: imp._id },
      { $set: { [`rows.${rowIndex}.status`]: "ignored" } }
    );
    await logAudit({
    collection: "rosterImports",
    documentId: imp._id!,
    action: "update",
      summary: `Ignored unmatched roster entry "${row.name}" (${row.target})`,
      performedBy: actorId,
    });
    return Response.json({ ok: true });
  }

  if (!assigneeId || !isValidObjectId(assigneeId)) {
    return Response.json({ error: "userId, ignore, or create action is required" }, { status: 400 });
  }

  if (!(await bindToTarget(db, row, toObjectId(assigneeId), actorId))) {
    return Response.json({ error: "Row has no valid target or date" }, { status: 400 });
  }

  await db.collection<RosterImport>("rosterImports").updateOne(
    { _id: imp._id },
    { $set: { [`rows.${rowIndex}.status`]: "created", [`rows.${rowIndex}.matchedUserId`]: assigneeId } }
  );

  await logAudit({
    collection: "rosterImports",
    documentId: imp._id,
    action: "update",
    summary: `Matched roster entry "${row.name}" (${row.target}) to ${assigneeId}`,
    performedBy: actorId,
  });

  return Response.json({ ok: true });
}

// One "create account" click for a single unmatched row: create the account,
// bind it to the row's slot/pool, and persist the generated credentials.
async function createOneAccount(
  db: Db,
  imp: RosterImport,
  rowIndex: number,
  actorId: ObjectId
): Promise<Response> {
  if (rowIndex < 0 || rowIndex >= imp.rows.length) {
    return Response.json({ error: "Row index out of range" }, { status: 400 });
  }
  const row = imp.rows[rowIndex];
  if (row.status !== "unmatched") return Response.json({ error: "Row already resolved" }, { status: 400 });

  const result = await createAccountForRow(db, imp, rowIndex, actorId, new Set<string>());
  if (result.skippedReason) {
    return Response.json({ error: `Cannot create account: ${result.skippedReason}`, rowIndex }, { status: 400 });
  }

  await logAudit({
    collection: "users",
    documentId: toObjectId(result.userId)!,
    action: "create",
    summary: `Created account for unmatched roster entry "${row.name}" (${row.phone}) from "${imp.sourceFileName}"`,
    performedBy: actorId,
  });

  return Response.json({
    ok: true,
    account: {
      name: result.account!.name,
      loginId: result.account!.loginId,
      password: result.account!.password,
    },
  });
}

// Bulk version: process every still-unmatched row across all review imports
// that has a phone, create accounts for any phone with no account yet, and
// bind everyone into their slot.
async function createAllAccounts(db: Db, actorId: ObjectId): Promise<Response> {
  const imports = await db
    .collection<RosterImport>("rosterImports")
    .find({ "rows.status": "unmatched" })
    .sort({ uploadedAt: -1 })
    .limit(5)
    .toArray();

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

  const remainingDocs = await db
    .collection<RosterImport>("rosterImports")
    .findOne({ "rows.status": "unmatched" });
  const remaining = remainingDocs ? remainingDocs.rows.filter((r) => r.status === "unmatched").length : 0;

  await logAudit({
    collection: "rosterImports",
    documentId: imports[0]?._id!,
    action: "update",
    summary: `Create accounts for unmatched roster entries: ${created.length} created, ${matchedExisting} matched existing, ${skipped.length} skipped`,
    performedBy: actorId,
  });

  return Response.json({ ok: true, created, matchedExisting, skipped, remaining });
}

// Creates (or reuses) an account for one unmatched row and binds it to its
// target. Returns the generated credentials (or null when the phone already
// had an account — in which case the person was just bound). Persists the
// row status + generated credentials back onto the import document.
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
  await db.collection<RosterImport>("rosterImports").updateOne({ _id: imp._id }, { $set: set });

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
    const res = await db.collection("emergencyDayPools").findOneAndUpdate(
      { date: localDate, shiftType },
      { $setOnInsert: { date: localDate, shiftType, createdBy: actorId, createdAt: new Date() }, $addToSet: { userIds: assigneeId } },
      { upsert: true, includeResultMetadata: true }
    );
    const poolDoc = res.value;
    const poolNew = Boolean(res.lastErrorObject?.upserted);
    if (poolDoc) {
      void logAudit({
        collection: "emergencyDayPools",
        documentId: poolDoc._id,
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
    const res = await db.collection("shiftAssignments").findOneAndUpdate(
      { date: localDate, roleSlotDefinitionId: toObjectId(slotId) },
      { $setOnInsert: { date: localDate, roleSlotDefinitionId: toObjectId(slotId) }, $addToSet: { userIds: assigneeId } },
      { upsert: true, includeResultMetadata: true }
    );
    const assignDoc = res.value;
    const assignNew = Boolean(res.lastErrorObject?.upserted);
    if (assignDoc) {
      void logAudit({
        collection: "shiftAssignments",
        documentId: assignDoc._id,
        action: assignNew ? "create" : "update",
        summary: `Bound ${assigneeId} to slot ${slotId} on ${row.date}`,
        performedBy: actorId,
      });
    }
    return true;
  }
  return false;
}
