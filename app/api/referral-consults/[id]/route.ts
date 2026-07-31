import { requireSession } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { toObjectId } from "@/lib/api";
import type { ReferralConsult } from "@/lib/models/types";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const userId = toObjectId((session.user as any).id);

  const body = await req.json();
  const db = await getDb();
  const existing = await db.collection<ReferralConsult>("referralConsults").findOne({ _id: toObjectId(params.id) });
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

  const update: Record<string, unknown> = { ...body };
  delete update.reviewedBy;
  delete update.reviewedAt;

  if (update.status === "reviewed") {
    if (!existing.recommendations && !existing.imageData && !update.recommendations && !update.imageData) {
      return Response.json({ error: "Add recommendations or attach a photo before marking done" }, { status: 400 });
    }
    update.reviewedAt = new Date();
    update.reviewedBy = userId;
  }
  if (update.status === "pending") {
    update.reviewedAt = null;
    update.reviewedBy = null;
  }

  await db.collection<ReferralConsult>("referralConsults").updateOne({ _id: existing._id }, { $set: update });

  await logAudit({
    collection: "referralConsults",
    documentId: existing._id,
    action: "update",
    summary: `Updated referral to ${existing.toSpecialty}: ${Object.keys(body).join(", ")}`,
    performedBy: userId,
  });

  const updated = await db.collection<ReferralConsult>("referralConsults").findOne({ _id: existing._id });
  return Response.json(updated);
}
