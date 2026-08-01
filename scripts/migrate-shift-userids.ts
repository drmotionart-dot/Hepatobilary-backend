// Run with: npm run migrate:shift-userids
// Applies the spec 6.1 schema change to an existing database, safely and
// idempotently (safe to re-run):
//   1. shiftAssignments: userId (single) -> userIds: ObjectId[] (group).
//      Existing single values become one-element arrays; unassigned become [].
//   2. roleSlotDefinitions: inserts the Friday ward-prep (تحضير عنبر) slot
//      if it is not already present — never wipes the rulebook.
//   3. users: does not alter accounts; roster imports add `phone` later.

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { MongoClient, ObjectId } from "mongodb";

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error("Missing MONGODB_URI in .env.local");

async function migrate() {
  const client = new MongoClient(uri as string);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || "hpb");

  const assignments = db.collection("shiftAssignments");
  const docs = await assignments
    .find({ $or: [{ userIds: { $exists: false } }, { userId: { $exists: true } }] })
    .toArray();

  let converted = 0;
  for (const doc of docs) {
    const userId = (doc as any).userId;
    const hasUserId = typeof userId !== "undefined" && userId !== null;
    const patch: Record<string, unknown> = {
      userIds: hasUserId ? [userId] : [],
    };
    await assignments.updateOne(
      { _id: doc._id },
      { $set: patch, $unset: { userId: "" } }
    );
    converted++;
  }
  console.log(`shiftAssignments converted: ${converted}`);

  const slots = db.collection("roleSlotDefinitions");
  const wardPrep = await slots.findOne({ dayType: "normal", category: "ward-prep" });
  if (!wardPrep) {
    await slots.insertOne({
      dayType: "normal",
      personType: "intern",
      shiftType: "long",
      category: "ward-prep",
      label: "Ward prep (تحضير عنبر)",
      weekdays: [5],
    });
    console.log("roleSlotDefinitions: inserted Friday ward-prep slot.");
  } else {
    console.log("roleSlotDefinitions: ward-prep slot already present.");
  }

  await client.close();
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
