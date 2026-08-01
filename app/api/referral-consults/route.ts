import { requireSession, requireRole, toObjectId, isValidObjectId } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { requireShiftKeyForIntern } from "@/lib/shift-key";
import type { ReferralConsult } from "@/lib/models/types";

export async function GET(req: Request) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const encounterId = url.searchParams.get("encounterId");
  const db = await getDb();

  if (encounterId && !isValidObjectId(encounterId)) {
    return Response.json({ error: "Invalid encounterId" }, { status: 400 });
  }
  const filter = encounterId ? { encounterId: toObjectId(encounterId) } : {};
  const referrals = await db.collection<ReferralConsult>("referralConsults").find(filter).sort({ referredAt: -1 }).toArray();
  return Response.json(referrals);
}

export async function POST(req: Request) {
  // Filling referral forms is intern/resident/admin (spec §7, amended).
  const session = await requireRole(["intern", "resident", "admin"]);
  if (!session) return Response.json({ error: "Intern or resident only" }, { status: 403 });
  const userId = toObjectId((session.user as any).id);

  const gate = await requireShiftKeyForIntern(req, session);
  if (!gate.allowed) return Response.json({ error: gate.message, code: gate.code }, { status: gate.status });

  const body = await req.json();
  const { encounterId, toSpecialty, reason } = body;
  if (!encounterId || !toSpecialty) {
    return Response.json({ error: "encounterId and toSpecialty are required" }, { status: 400 });
  }
  if (!isValidObjectId(encounterId)) {
    return Response.json({ error: "Invalid encounterId" }, { status: 400 });
  }

  const db = await getDb();
  const doc: ReferralConsult = {
    encounterId: toObjectId(encounterId),
    toSpecialty,
    reason: reason || "",
    referredBy: userId,
    referredAt: new Date(),
    status: "pending",
  };
  const res = await db.collection<ReferralConsult>("referralConsults").insertOne(doc);

  await logAudit({
    collection: "referralConsults",
    documentId: res.insertedId,
    action: "create",
    summary: `Referred to ${toSpecialty}`,
    performedBy: userId,
    shiftKey: gate.shiftKey,
    shiftKeyMatched: gate.shiftKeyMatched,
  });

  return Response.json({ ...doc, _id: res.insertedId }, { status: 201 });
}
