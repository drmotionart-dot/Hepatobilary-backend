import { MongoClient, Db } from "mongodb";

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "hpb";

if (!uri) {
  throw new Error("Missing MONGODB_URI — copy .env.example to .env.local and fill it in.");
}

// Cache the client across hot-reloads in dev and across invocations in serverless
// prod, so we don't open a new connection on every request.
let cachedClient: MongoClient | null = null;
let cachedDb: Db | null = null;

export async function getDb(): Promise<Db> {
  if (cachedDb) return cachedDb;

  const client = cachedClient ?? new MongoClient(uri as string);
  if (!cachedClient) {
    await client.connect();
    cachedClient = client;
  }

  cachedDb = client.db(dbName);
  return cachedDb;
}
