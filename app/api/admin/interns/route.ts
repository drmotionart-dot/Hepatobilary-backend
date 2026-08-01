import { requireRole } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import type { User } from "@/lib/models/types";

// Round Interns directory (spec 11.8): every ACTIVE intern, sorted by name.
// Resident + Admin. Unlike GET /api/admin/users (account management, admin-only
// after the resident-panel split) this directory stays open to residents so
// they can reach any intern's profile.
export async function GET() {
  const session = await requireRole(["admin", "resident"]);
  if (!session) return Response.json({ error: "Admin or resident only" }, { status: 403 });

  const db = await getDb();
  const interns = await db
    .collection<User>("users")
    .find({ role: "intern", status: "active" })
    .project({ passwordHash: 0 })
    .sort({ fullName: 1 })
    .toArray();
  return Response.json(interns);
}
