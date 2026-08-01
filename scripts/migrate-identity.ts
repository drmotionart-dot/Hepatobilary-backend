// Run with: npm run migrate:identity
// Brings the users collection in line with spec 3.1: every user gets a
// unique `loginId` (their current login credential — for existing users that
// is their email), and `phone` becomes the canonical, normalized identity key
// (backfilled from rotation-import "number" rows where available). Finally it
// creates the unique indexes. Idempotent — safe to re-run.

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { MongoClient } from "mongodb";
import type { User, RotationImport } from "../lib/models/types";
import { normalizePhone } from "../lib/roster-import";

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error("Missing MONGODB_URI in .env.local");

async function migrate() {
  const client = new MongoClient(uri as string);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || "hpb");

  // 1) Phone backfill map: rotation-import row "number" -> created user (_id).
  const rotations = await db.collection<RotationImport>("rotationImports").find({}).toArray();
  const phoneByUserId = new Map<string, string>();
  for (const rot of rotations) {
    for (const row of rot.rows || []) {
      if (row.number && row.generatedUserId) {
        const p = normalizePhone(row.number);
        if (p && !phoneByUserId.has(row.generatedUserId)) phoneByUserId.set(row.generatedUserId, p);
      }
    }
  }
  console.log(`Loaded ${phoneByUserId.size} rotation-import phone records.`);

  // 2) Normalize/backfill loginId + phone per user.
  const users = await db.collection<User>("users").find({}).toArray();
  const loginIds = new Set<string>();
  let loginIdSet = 0;
  let phoneSet = 0;
  let phoneNormalized = 0;
  const collisions: string[] = [];

  for (const u of users) {
    const idStr = u._id!.toString();
    const update: Record<string, unknown> = {};

    let loginId = u.loginId;
    if (!loginId) {
      loginId = u.email?.toLowerCase().trim() || "";
      if (!loginId) {
        const fromPhone = u.phone ? normalizePhone(u.phone) : phoneByUserId.get(idStr) || "";
        loginId = fromPhone ? `hpb${fromPhone}` : `hpb-${idStr.slice(0, 8)}`;
      }
      loginId = loginId.toLowerCase();
      // Guarantee uniqueness (append a counter if needed).
      if (loginIds.has(loginId)) {
        let n = 2;
        const base = loginId;
        while (loginIds.has(`${base}${n}`)) n++;
        loginId = `${base}${n}`;
        collisions.push(`${u.fullName} (${idStr}) -> ${loginId}`);
      }
      update.loginId = loginId;
      loginIdSet++;
    }
    loginIds.add(loginId.toLowerCase());

    // Normalize any stored phone to canonical digits.
    let phone = u.phone ? normalizePhone(u.phone) : "";
    if (u.phone && phone !== u.phone) {
      update.phone = phone;
      phoneNormalized++;
    }

    // Backfill a missing phone from rotation imports.
    if (!phone) {
      const fromImport = phoneByUserId.get(idStr);
      if (fromImport) {
        update.phone = fromImport;
        phoneSet++;
      }
    }

    if (Object.keys(update).length) {
      update.updatedAt = new Date();
      await db.collection<User>("users").updateOne({ _id: u._id }, { $set: update });
    }
  }

  // 3) Unique indexes. phone is sparse so many users can legitimately have none.
  await db.collection("users").createIndex({ loginId: 1 }, { unique: true });
  await db.collection("users").createIndex({ phone: 1 }, { unique: true, sparse: true });

  console.log(`loginId set on ${loginIdSet} users.`);
  console.log(`phone backfilled on ${phoneSet} users, normalized on ${phoneNormalized}.`);
  if (collisions.length) console.log("loginId collisions resolved:", collisions);
  console.log("Indexes ensured: loginId (unique), phone (unique + sparse).");

  await client.close();
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
