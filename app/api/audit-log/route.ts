import { requireRole } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";
import type { Filter } from "mongodb";
import type { AuditLog } from "@/lib/models/types";

export async function GET(req: Request) {
  const session = await requireRole(["resident", "admin"]);
  if (!session) return Response.json({ error: "Resident or admin only" }, { status: 403 });

  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100"), 500);
  const collection = url.searchParams.get("collection");
  const action = url.searchParams.get("action");
  const user = url.searchParams.get("user");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const db = await getDb();
  const filter: Filter<AuditLog> = {};
  if (collection) filter.collection = collection;
  if (action) filter.action = action as AuditLog["action"];
  if (user) {
    try {
      filter.performedBy = new ObjectId(user);
    } catch {
      return Response.json({ error: "Invalid user id" }, { status: 400 });
    }
  }
  if (from || to) {
    const range: { $gte?: Date; $lte?: Date } = {};
    const parseDateInput = (v: string) => {
      const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00`) : new Date(v);
      return isNaN(d.getTime()) ? null : d;
    };
    if (from) {
      const f = parseDateInput(from);
      if (f) range.$gte = f;
    }
    if (to) {
      const t = parseDateInput(to);
      if (t) {
        t.setHours(23, 59, 59, 999);
        range.$lte = t;
      }
    }
    if (Object.keys(range).length > 0) filter.performedAt = range;
  }

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
