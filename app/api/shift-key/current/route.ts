import { requireSession } from "@/lib/api";
import { getActiveKey } from "@/lib/shift-key";

// GET /api/shift-key/current — the currently active shift key. Available to any
// authenticated staff member so the client can cache it for offline validation
// (spec 11.6). Residents/admins see it in the top bar; interns' clients cache it
// silently. Returns null when no key has been generated yet.
export async function GET() {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const active = await getActiveKey();
  if (!active) return Response.json({ key: null });
  return Response.json({ key: active.key, generatedAt: active.generatedAt });
}
