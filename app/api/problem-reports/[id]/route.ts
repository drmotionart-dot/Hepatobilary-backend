import { requireRole, toObjectId, isValidObjectId } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import type { ProblemReport } from "@/lib/models/types";

// PATCH /api/problem-reports/[id] — resident/admin marks a report resolved.
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await requireRole(["resident", "admin"]);
  if (!session) return Response.json({ error: "Resident or admin only" }, { status: 403 });
  const { id } = params;
  if (!isValidObjectId(id)) return Response.json({ error: "Invalid report id" }, { status: 400 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { status } = (body || {}) as { status?: unknown };
  if (status !== "resolved" && status !== "open") {
    return Response.json({ error: 'status must be "open" or "resolved"' }, { status: 400 });
  }

  const db = await getDb();
  const update =
    status === "resolved"
      ? { $set: { status: "resolved" as const, resolvedBy: toObjectId(session.user.id), resolvedAt: new Date() } }
      : { $set: { status: "open" as const, resolvedBy: null, resolvedAt: null } };

  const res = await db
    .collection<ProblemReport>("problemReports")
    .findOneAndUpdate({ _id: toObjectId(id) }, update, { returnDocument: "after" });

  if (!res) return Response.json({ error: "Report not found" }, { status: 404 });
  return Response.json(res);
}
