import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { toObjectId } from "@/lib/api";
import type { ObjectId } from "mongodb";
import type { ShiftKey } from "@/lib/models/types";

// Ward shift-key core (spec 11.6). A resident/admin generates a rotating key;
// interns must submit it on gated patient-data actions. Keys are never deleted —
// history lets offline queued actions be re-validated against the key that was
// active at the timestamp the action was actually performed.

const KEY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L ambiguity

function randomKey(length = 6): string {
  let out = "";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < length; i++) out += KEY_ALPHABET[bytes[i] % KEY_ALPHABET.length];
  return out;
}

export async function getActiveKey(): Promise<ShiftKey | null> {
  const db = await getDb();
  return db.collection<ShiftKey>("shiftKeys").findOne({ active: true }, { sort: { generatedAt: -1 } });
}

// The key that was active at timestamp `at`, reconstructed from history.
// Returns null when no key existed yet at that time.
export async function getKeyActiveAt(at: Date): Promise<ShiftKey | null> {
  const db = await getDb();
  return db
    .collection<ShiftKey>("shiftKeys")
    .findOne({ generatedAt: { $lte: at } }, { sort: { generatedAt: -1 } });
}

// Generates a fresh active key, deactivating the previous one. History retained.
export async function generateShiftKey(generatedBy: string): Promise<ShiftKey> {
  const db = await getDb();
  const now = new Date();
  await db.collection<ShiftKey>("shiftKeys").updateMany(
    { active: true },
    { $set: { active: false, deactivatedAt: now } }
  );
  const doc: ShiftKey = {
    key: randomKey(),
    generatedBy: toObjectId(generatedBy),
    generatedAt: now,
    deactivatedAt: null,
    active: true,
  };
  await db.collection<ShiftKey>("shiftKeys").insertOne(doc);
  await logAudit({
    collection: "shiftKeys",
    documentId: doc._id!,
    action: "create",
    summary: `Shift key ${doc.key} generated (previous key deactivated)`,
    performedBy: doc.generatedBy,
  });
  return doc;
}

export interface ShiftKeyGate {
  allowed: boolean;
  status?: number;
  code?: string;
  message?: string;
  shiftKey?: string | null;
  shiftKeyMatched?: boolean;
}

// Enforces the intern shift-key gate (spec 11.6) for a gated route.
//  - Residents/admins are never gated.
//  - Online submissions must match the CURRENT active key → 403 on mismatch,
//    nothing is created.
//  - Offline sync replays (x-sync-replay + x-performed-at) are re-validated
//    against the key active at that timestamp — accepted either way, with
//    `shiftKeyMatched` set so the caller can flag mismatches for review.
// Callers must pass `shiftKey`/`shiftKeyMatched` through to logAudit.
export async function requireShiftKeyForIntern(req: Request, session: { user: { role: string } }): Promise<ShiftKeyGate> {
  if (session.user.role !== "intern") {
    return { allowed: true, shiftKeyMatched: true };
  }

  const key = req.headers.get("x-shift-key")?.trim() ?? "";
  const syncReplay = req.headers.get("x-sync-replay")?.toLowerCase() === "true";
  const performedAtRaw = req.headers.get("x-performed-at");

  if (!key) {
    return {
      allowed: false,
      status: 403,
      code: "shift-key-missing",
      message: "This action requires the current shift key.",
      shiftKey: null,
      shiftKeyMatched: false,
    };
  }

  if (syncReplay && performedAtRaw) {
    const performedAt = new Date(performedAtRaw);
    if (!isNaN(performedAt.getTime())) {
      const historical = await getKeyActiveAt(performedAt);
      const matched = Boolean(historical && historical.key === key);
      return { allowed: true, shiftKey: key, shiftKeyMatched: matched };
    }
  }

  const active = await getActiveKey();
  const matched = Boolean(active && active.key === key);
  if (!matched) {
    return {
      allowed: false,
      status: 403,
      code: "shift-key-invalid",
      message: "Incorrect shift key — this action was not saved.",
      shiftKey: key,
      shiftKeyMatched: false,
    };
  }
  return { allowed: true, shiftKey: key, shiftKeyMatched: true };
}
