import { requireRole, toObjectId, isValidObjectId } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import type { User } from "@/lib/models/types";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  // All account lifecycle actions are admin-only (spec §7 — account management
  // is not part of the resident panel).
  const session = await requireRole(["admin"]);
  if (!session) return Response.json({ error: "Admin only" }, { status: 403 });
  const actingId = toObjectId((session.user as any).id);

  const body = await req.json();
  const db = await getDb();
  if (!isValidObjectId(params.id)) return Response.json({ error: "Invalid user id" }, { status: 400 });
  const user = await db.collection<User>("users").findOne({ _id: toObjectId(params.id) });
  if (!user) return Response.json({ error: "User not found" }, { status: 404 });

  const update: Record<string, unknown> = { updatedAt: new Date() };

  if (body.action === "approve") {
    update.status = "active";
    update.approvedBy = actingId;
    update.approvedAt = new Date();
  } else if (body.action === "reject") {
    update.status = "removed";
  } else if (body.action === "remove") {
    update.status = "removed";
  } else if (body.action === "expire") {
    update.status = "expired";
  } else if (body.action === "reinstate") {
    update.status = "active";
    update.approvedAt = new Date();
  } else {
    const allowed = ["role", "status", "mustChangePassword"];
    for (const key of allowed) {
      if (body[key] !== undefined) update[key] = body[key];
    }
  }

  await db.collection<User>("users").updateOne({ _id: user._id }, { $set: update });

  await logAudit({
    collection: "users",
    documentId: user._id,
    action: "update",
    summary: `Account action on ${user.loginId}: ${body.action || Object.keys(body).join(", ")}`,
    performedBy: actingId,
  });

  const updated = await db.collection<User>("users").findOne({ _id: user._id });
  return Response.json(updated);
}
