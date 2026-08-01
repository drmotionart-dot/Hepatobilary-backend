import { requireCapability } from "@/lib/api";
import { generateShiftKey } from "@/lib/shift-key";

// POST /api/shift-key/generate — deactivates the previous key and creates a new
// active one (spec 11.6). Allowed for residents/admins, and for interns holding
// the "generate-shift-key" capability (spec 11.7).
export async function POST() {
  const session = await requireCapability("generate-shift-key");
  if (!session) return Response.json({ error: "Forbidden" }, { status: 403 });
  const doc = await generateShiftKey(session.user.id);
  return Response.json({ key: doc.key, generatedAt: doc.generatedAt });
}
