// Run with: npx tsx scripts/seed-lab-mappings.ts
// Idempotently upserts lab test name mappings into an existing DB (keeps any
// admin-added mappings not present in the seed list, refreshes the seed ones)
// and drops the stale "#Haemoglobin" entry (parser now strips the leading "#").

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { MongoClient } from "mongodb";
import { labTestNameMappings } from "./lab-test-mappings";

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error("Missing MONGODB_URI in .env.local");

async function main() {
  const client = new MongoClient(uri as string);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || "hpb");
  const col = db.collection("labTestNameMappings");

  for (const m of labTestNameMappings) {
    await col.updateOne(
      { externalTestName: m.externalTestName },
      { $set: { internalTestKey: m.internalTestKey, category: m.category } },
      { upsert: true }
    );
  }

  const removed = await col.deleteOne({ externalTestName: "#Haemoglobin" });

  const count = await col.countDocuments();
  console.log(`Upserted ${labTestNameMappings.length} lab test name mappings.`);
  console.log(`Removed stale "#Haemoglobin": ${removed.deletedCount > 0}`);
  console.log(`Total mappings now: ${count}`);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
