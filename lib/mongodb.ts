import { MongoClient, Db } from "mongodb";

// Mongo connection is resolved lazily — at first getDb() call, never at module
// import. next build evaluates route modules during page-data collection, so a
// missing MONGODB_URI at import time would fail every env-less build (e.g.
// preview deployments without env vars). Real requests in a deployed
// environment always have the env var set.
function getConfig(): { uri: string; dbName: string } {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || "hpb";
  if (!uri) {
    throw new Error("Missing MONGODB_URI — copy .env.example to .env.local and fill it in.");
  }
  return { uri, dbName };
}

// The client lives on globalThis so Next dev hot-reloads never orphan a cached
// connection: re-evaluating this module re-reads the existing client instead of
// constructing a new one whose sockets would linger (driver default pool is 100
// and idle sockets never time out, which drives Atlas free-tier connection
// churn). In serverless prod each warm container caches the same client across
// invocations.
const globalForMongo = globalThis as unknown as { _hpbMongoClient?: MongoClient };

// Bound the pool: this app is low-traffic, one or two sockets are plenty, and a
// hard cap keeps a single instance from ballooning toward the 100-connection
// driver default. Idle sockets are returned after a minute.
function createClient(uri: string): MongoClient {
  return new MongoClient(uri, {
    maxPoolSize: 10,
    minPoolSize: 0,
    maxIdleTimeMS: 60_000,
  });
}

// One-shot index bootstrap (spec 3.13 — roster/day-type lookups are the hot path
// in dashboard, self-book, roster/board and roster/export). Runs once per
// process; a failure logs loudly but never breaks requests.
let ensureIndexesPromise: Promise<void> | null = null;

function ensureIndexes(db: Db): Promise<void> {
  if (!ensureIndexesPromise) {
    ensureIndexesPromise = Promise.all([
      db.collection("users").createIndex({ loginId: 1 }, { unique: true }),
      db.collection("users").createIndex({ email: 1 }, { unique: true, sparse: true }),
      db.collection("users").createIndex({ phone: 1 }, { unique: true, sparse: true }),
      db.collection("patients").createIndex({ medicalNumber: 1 }, { unique: true, sparse: true }),
      db.collection("encounters").createIndex({ status: 1, type: 1 }),
      db.collection("encounters").createIndex({ patientId: 1, date: -1 }),
      db.collection("shiftAssignments").createIndex({ date: 1, roleSlotDefinitionId: 1 }),
      db.collection("dayTypeCalendar").createIndex({ date: 1 }, { unique: true }),
      db.collection("clinicalNotes").createIndex({ encounterId: 1 }),
      db.collection("labPanels").createIndex({ encounterId: 1 }),
      db.collection("auditLogs").createIndex({ performedAt: -1 }),
      db.collection("auditLogs").createIndex({ performedBy: 1, performedAt: -1 }),
      db.collection("labImports").createIndex({ status: 1 }),
      db.collection("shiftKeys").createIndex({ active: 1, generatedAt: -1 }),
      db.collection("shiftKeys").createIndex({ key: 1 }, { unique: true }),
      db.collection("attendance").createIndex({ userId: 1, date: 1 }, { unique: true }),
    ])
      .then(() => undefined)
      .catch((err) => {
        console.error("ensureIndexes failed:", err);
      });
  }
  return ensureIndexesPromise;
}

export async function getDb(): Promise<Db> {
  const { uri, dbName } = getConfig();
  const cached = globalForMongo._hpbMongoClient;
  if (cached) return cached.db(dbName);

  const client = createClient(uri);
  await client.connect();
  globalForMongo._hpbMongoClient = client;
  const db = client.db(dbName);
  void ensureIndexes(db);
  return db;
}
