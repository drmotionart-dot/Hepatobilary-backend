import { requireCapability, toObjectId } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { handleRoute } from "@/lib/http";
import {
  listReviewQueue,
  resolveReviewRow,
  createOneAccount,
  createAllAccounts,
} from "@/lib/services/rosterService";

// Review queue for the Wardyati roster import, mirroring the lab-import
// "needs review" pattern (spec 6.1 step 2): entries whose phone/name matched
// no known user are listed here so a resident/admin can bind them to an
// existing account, ignore them, or — the key action — create a new account
// on the spot (spec 6.1 step 4). "Create accounts" reuses the exact same
// bulk-account generation as the rotation Excel import (spec 10.2), so a
// person only ever needs one account no matter which import meets them first.
export async function GET(req: Request) {
  const session = await requireCapability("manage-roster");
  if (!session) return Response.json({ error: "Requires the manage-roster capability" }, { status: 403 });

  return handleRoute(req, async () => {
    const db = await getDb();
    const queue = await listReviewQueue(db);
    return Response.json(queue);
  });
}

// POST actions on the review queue:
//   { importId, rowIndex, userId }        — bind to an existing account
//   { importId, rowIndex, ignore: true }  — mark skipped
//   { importId, action: "create-account", rowIndex } — create ONE account + bind
//   { importId, action: "create-all" }    — create/bind every unmatched row with a phone
export async function POST(req: Request) {
  const session = await requireCapability("manage-roster");
  if (!session) return Response.json({ error: "Requires the manage-roster capability" }, { status: 403 });
  const actorId = toObjectId((session.user as any).id);

  return handleRoute(req, async () => {
    const body = await req.json();
    const db = await getDb();
    const { importId, rowIndex, action } = body;

    // "Create accounts for all unmatched" spans every import still in the queue.
    if (action === "create-all") {
      const result = await createAllAccounts(db, actorId);
      return Response.json(result);
    }

    if (action === "create-account") {
      const result = await createOneAccount(db, importId, rowIndex, actorId);
      return Response.json(result);
    }

    const result = await resolveReviewRow(db, body, actorId);
    return Response.json(result);
  });
}
