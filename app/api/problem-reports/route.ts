import { requireSession, requireRole, toObjectId } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";
import type { ProblemReport } from "@/lib/models/types";

const MAX_DESCRIPTION = 2000;

// POST /api/problem-reports — any authenticated role (intern/resident/admin)
// files a low-friction report from the top-bar button. Deliberately NO shift-key
// gate: reporting must never be blocked mid-shift.
export async function POST(req: Request) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const userId = toObjectId(session.user.id);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { description, url } = (body || {}) as { description?: unknown; url?: unknown };

  const text = typeof description === "string" ? description.trim() : "";
  if (!text) return Response.json({ error: "description is required" }, { status: 400 });
  if (text.length > MAX_DESCRIPTION) {
    return Response.json({ error: `description must be at most ${MAX_DESCRIPTION} characters` }, { status: 400 });
  }

  const urlText = typeof url === "string" && url.trim() ? url.trim().slice(0, 500) : null;

  const doc: ProblemReport = {
    description: text,
    url: urlText,
    role: session.user.role,
    performedBy: userId,
    status: "open",
    correlationId: req.headers.get("x-correlation-id")?.slice(0, 200) || null,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: new Date(),
  };

  const db = await getDb();
  const res = await db.collection<ProblemReport>("problemReports").insertOne(doc);

  return Response.json({ _id: res.insertedId, ...doc }, { status: 201 });
}

// GET /api/problem-reports — resident/admin only. Latest first, with the
// reporter's name joined in (same pattern as /api/audit-log).
export async function GET(req: Request) {
  const session = await requireRole(["resident", "admin"]);
  if (!session) return Response.json({ error: "Resident or admin only" }, { status: 403 });

  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100"), 500);
  const status = url.searchParams.get("status");
  const onlyOpen = url.searchParams.get("onlyOpen");

  const filter: { status?: "open" | "resolved" } = {};
  if (status === "open" || status === "resolved") filter.status = status;
  else if (onlyOpen === "true") filter.status = "open";

  const db = await getDb();
  const reports = await db
    .collection<ProblemReport>("problemReports")
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();

  const userIds = [...new Set(reports.map((r) => r.performedBy.toString()))];
  const users = userIds.length
    ? await db.collection("users").find({ _id: { $in: userIds.map((id) => new ObjectId(id)) } }).toArray()
    : [];
  const userMap = new Map(users.map((u: any) => [u._id.toString(), u.fullName]));

  return Response.json(
    reports.map((r) => ({
      ...r,
      performedByName: userMap.get(r.performedBy.toString()) || "Unknown",
    }))
  );
}
