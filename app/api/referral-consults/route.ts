import { requireSession } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { toObjectId } from "@/lib/api";
import type { ReferralConsult } from "@/lib/models/types";

export async function GET(req: Request) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const encounterId = url.searchParams.get("encounterId");
  const db = await getDb();

  const filter = encounterId ? { encounterId: toObjectId(encounterId) } : {};
  const referrals = await db.collection<ReferralConsult>("referralConsults").find(filter).sort({ referredAt: -1 }).toArray();
  return Response.json(referrals);
}

export async function POST(req: Request) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const userId = toObjectId((session.user as any).id);

  const body = await req.json();
  const { encounterId, toSpecialty, reason } = body;
  if (!encounterId || !toSpecialty) {
    return Response.json({ error: "encounterId and toSpecialty are required" }, { status: 400 });
  }

  const db = await getDb();
  const doc: ReferralConsult = {
    encounterId: toObjectId(encounterId),
    toSpecialty,
    reason: reason || "",
    referredBy: userId,
    referredAt: new Date(),
    status: "pending",
    reviewNoteId: null,
  };
  const res = await db.collection<ReferralConsult>("referralConsults").insertOne(doc);

  await logAudit({
    collection: "referralConsults",
    documentId: res.insertedId,
    action: "create",
    summary: `Referred to ${toSpecialty}`,
    performedBy: userId,
  });

  return Response.json({ ...doc, _id: res.insertedId }, { status: 201 });
}
