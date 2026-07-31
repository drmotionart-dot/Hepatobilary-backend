import { requireRole } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";
import type { AuditLog } from "@/lib/models/types";

export async function GET(req: Request) {
  const session = await requireRole(["resident", "admin"]);
  if (!session) return Response.json({ error: "Resident or admin only" }, { status: 403 });

  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100"), 500);
  const collection = url.searchParams.get("collection");

  const db = await getDb();
  const filter = collection ? { collection } : {};
  const logs = await db
    .collection<AuditLog>("auditLogs")
    .find(filter)
    .sort({ performedAt: -1 })
    .limit(limit)
    .toArray();

  const userIds = [...new Set(logs.map((l) => l.performedBy.toString()))];
  const users = userIds.length
    ? await db.collection("users").find({ _id: { $in: userIds.map((id) => new ObjectId(id)) } }).toArray()
    : [];
  const userMap = new Map(users.map((u: any) => [u._id.toString(), u.fullName]));

  return Response.json(
    logs.map((l) => ({
      ...l,
      performedByName: userMap.get(l.performedBy.toString()) || "Unknown",
    }))
  );
}
