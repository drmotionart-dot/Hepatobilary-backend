import { requireSession } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import type { RoleSlotDefinition } from "@/lib/models/types";

export async function GET() {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const db = await getDb();
  const slots = await db.collection<RoleSlotDefinition>("roleSlotDefinitions").find().toArray();
  return Response.json(slots);
}
