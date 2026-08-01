import { requireRole, toObjectId, isValidObjectId } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { CAPABILITIES, isCapability } from "@/lib/models/types";
import type { Capability, User } from "@/lib/models/types";

// PUT /api/admin/users/[id]/capabilities — set-semantics grant/revoke for an
// intern's grantedCapabilities (spec 11.7/11.8). Admin or resident. The whole
// list is replaced, so the UI sends the full desired set. Audit-logged.
export async function PUT(req: Request, { params }: { params: { id: string } }) {
  const session = await requireRole(["admin", "resident"]);
  if (!session) return Response.json({ error: "Admin or resident only" }, { status: 403 });
  const actingId = toObjectId((session.user as any).id);

  const body = await req.json();
  const db = await getDb();
  if (!isValidObjectId(params.id)) return Response.json({ error: "Invalid user id" }, { status: 400 });
  const user = await db.collection<User>("users").findOne({ _id: toObjectId(params.id) });
  if (!user) return Response.json({ error: "User not found" }, { status: 404 });

  const caps = Array.isArray(body.capabilities)
    ? (body.capabilities as unknown[]).filter((c): c is Capability => isCapability(c))
    : [];

  await db.collection<User>("users").updateOne(
    { _id: user._id },
    { $set: { grantedCapabilities: caps, updatedAt: new Date() } }
  );

  await logAudit({
    collection: "users",
    documentId: user._id,
    action: "update",
    summary: `Capabilities for ${user.loginId} set to [${caps.join(", ") || "none"}] (available: ${CAPABILITIES.join(", ")})`,
    performedBy: actingId,
  });

  const updated = await db.collection<User>("users").findOne({ _id: user._id });
  return Response.json(updated);
}
