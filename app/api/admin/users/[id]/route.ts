import { requireRole } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { toObjectId } from "@/lib/api";
import type { User } from "@/lib/models/types";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await requireRole(["admin"]);
  if (!session) return Response.json({ error: "Admin only" }, { status: 403 });
  const adminId = toObjectId((session.user as any).id);

  const body = await req.json();
  const db = await getDb();
  const user = await db.collection<User>("users").findOne({ _id: toObjectId(params.id) });
  if (!user) return Response.json({ error: "User not found" }, { status: 404 });

  const update: Record<string, unknown> = { updatedAt: new Date() };

  // Self-registered accounts: approve → active forever (spec 10.2)
  if (body.action === "approve") {
    update.status = "active";
    update.approvedBy = adminId;
    update.approvedAt = new Date();
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
    summary: `Admin action on ${user.email}: ${JSON.stringify(Object.keys(update))}`,
    performedBy: adminId,
  });

  const updated = await db.collection<User>("users").findOne({ _id: user._id });
  return Response.json(updated);
}
