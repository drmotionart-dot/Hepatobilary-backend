import { getDb } from "@/lib/mongodb";

// GET /api/health — unauthenticated liveness + DB reachability probe for load
// tests, uptime checks and the runbook. No data, no credentials needed.
// Force dynamic so it reflects the live DB, not build-time state.
export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = Date.now();
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    return Response.json({
      status: "ok",
      db: "connected",
      latencyMs: Date.now() - startedAt,
      time: new Date().toISOString(),
    });
  } catch {
    return Response.json(
      {
        status: "degraded",
        db: "unreachable",
        latencyMs: Date.now() - startedAt,
        time: new Date().toISOString(),
      },
      { status: 503 }
    );
  }
}
