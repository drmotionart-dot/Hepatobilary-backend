import { MongoClient, Db } from "mongodb";

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "hpb";

if (!uri) {
  throw new Error("Missing MONGODB_URI — copy .env.example to .env.local and fill it in.");
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
function createClient(): MongoClient {
  return new MongoClient(uri as string, {
    maxPoolSize: 10,
    minPoolSize: 0,
    maxIdleTimeMS: 60_000,
  });
}

export async function getDb(): Promise<Db> {
  const cached = globalForMongo._hpbMongoClient;
  if (cached) return cached.db(dbName);

  const client = createClient();
  await client.connect();
  globalForMongo._hpbMongoClient = client;
  return client.db(dbName);
}
