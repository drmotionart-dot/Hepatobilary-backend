import { requireSession } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import type { User } from "@/lib/models/types";

// Active users list — used by shift assignment, discharge/op forms dropdowns.
export async function GET() {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const db = await getDb();
  const users = await db
    .collection<User>("users")
    .find({ status: "active" })
    .project({ passwordHash: 0 })
    .sort({ fullName: 1 })
    .toArray();
  return Response.json(users);
}
