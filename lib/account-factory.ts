import bcrypt from "bcryptjs";
import type { Db, ObjectId } from "mongodb";
import type { User } from "@/lib/models/types";
import { normalizePhone } from "@/lib/roster-import";

// Single source of truth for bulk-generated account creation (spec 10.2 /
// spec 6.1 step 4). Both the rotation Excel import and the roster review
// "create accounts for unmatched" action go through here, so a person only
// ever needs one account no matter which import meets them first. Phone is
// the canonical identity key — matched before creating, so duplicates are
// impossible.

export const BULK_ACCOUNT_LIFETIME_DAYS = 50;

export type BulkAccountResult =
  | { status: "created"; user: User; loginId: string; password: string }
  | { status: "existing"; user: User; loginId: string };

export interface CreateBulkAccountInput {
  fullName: string;
  phone?: string | null;
  email?: string | null;
  role?: "intern" | "resident";
  rotationImportId?: ObjectId | null;
  approvedBy?: ObjectId | null;
  usedLoginIds?: Set<string>;
}

function randomChars(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

// Generated login ID is the phone, prefixed with "hpb" (e.g. hpb01123456789)
// so it is unique by construction, shareable, and distinct from an email.
export function generateLoginId(phone?: string | null, used = new Set<string>()): string {
  const digits = phone ? normalizePhone(phone) : "";
  const base = (digits ? `hpb${digits}` : `hpb${randomChars(6)}`).toLowerCase();
  let candidate = base;
  let n = 1;
  while (used.has(candidate)) candidate = `${base}${n++}`;
  used.add(candidate);
  return candidate;
}

export function generatePassword(): string {
  return `Hpb@${randomChars(8)}`;
}

// Creates a bulk-generated account. Dedupes on the normalized phone first —
// a phone that already exists returns status "existing" instead of creating a
// second account. loginId/password are generated here so both import flows
// produce identical, working credentials.
export async function createBulkAccount(
  db: Db,
  input: CreateBulkAccountInput
): Promise<BulkAccountResult> {
  const fullName = input.fullName.trim();
  const phone = input.phone ? normalizePhone(input.phone) : "";

  if (phone) {
    const existing = await db.collection<User>("users").findOne({ phone });
    if (existing) {
      return { status: "existing", user: existing, loginId: existing.loginId || "" };
    }
  }

  const loginId = generateLoginId(phone, input.usedLoginIds);
  const password = generatePassword();
  const now = new Date();

  const user: User = {
    fullName,
    role: input.role || "intern",
    loginId,
    email: input.email ? input.email.trim().toLowerCase() : null,
    ...(phone ? { phone } : {}),
    passwordHash: await bcrypt.hash(password, 10),
    accountType: "bulk-generated",
    status: "active",
    approvedBy: input.approvedBy || null,
    approvedAt: now,
    mustChangePassword: true,
    expiresAt: new Date(now.getTime() + BULK_ACCOUNT_LIFETIME_DAYS * 24 * 60 * 60 * 1000),
    rotationImportId: input.rotationImportId || null,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const res = await db.collection<User>("users").insertOne(user);
    return { status: "created", user: { ...user, _id: res.insertedId }, loginId, password };
  } catch (err: any) {
    // Unique phone or loginId index caught a race — someone else created it first.
    if (err?.code === 11000 && phone) {
      const existing = await db.collection<User>("users").findOne({ phone });
      if (existing) return { status: "existing", user: existing, loginId: existing.loginId || "" };
    }
    throw err;
  }
}
