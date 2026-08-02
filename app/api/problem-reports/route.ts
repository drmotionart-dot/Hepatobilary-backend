import { requireSession, requireRole, toObjectId } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logger } from "@/lib/logger";
import { ObjectId } from "mongodb";
import type { ProblemReport, ProblemReportContext } from "@/lib/models/types";

const MAX_DESCRIPTION = 2000;
const MAX_STRING = 500;
const MAX_CONSOLE_LINES = 50;

function cleanStr(v: unknown, max = MAX_STRING): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function cleanContext(raw: unknown): ProblemReportContext | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  const recent = Array.isArray(c.recentConsole)
    ? (c.recentConsole as unknown[])
        .filter((x): x is { level: string; message: string; at: string } => !!x && typeof x === "object")
        .slice(0, MAX_CONSOLE_LINES)
        .map((l) => {
          const level = l.level === "error" || l.level === "warn" || l.level === "log" ? l.level : "log";
          return {
            level: level as "log" | "warn" | "error",
            message: cleanStr(l.message, 2000) || "",
            at: cleanStr(l.at, 80) || "",
          };
        })
        .filter((l) => l.message)
    : [];
  const pending = typeof c.pendingOffline === "number" && Number.isFinite(c.pendingOffline) ? Math.max(0, c.pendingOffline) : 0;
  const ctx: ProblemReportContext = {
    ua: cleanStr(c.ua, 1000),
    language: cleanStr(c.language, 50),
    platform: cleanStr(c.platform, 100),
    timezone: cleanStr(c.timezone, 100),
    screen: cleanStr(c.screen, 50),
    viewport: cleanStr(c.viewport, 50),
    deviceType: cleanStr(c.deviceType, 20),
    localTime: cleanStr(c.localTime, 80),
    pendingOffline: pending,
    recentConsole: recent,
  };
  return ctx;
}

// POST /api/problem-reports — any authenticated role (intern/resident/admin)
// files a low-friction report from the top-bar button. Deliberately NO shift-key
// gate: reporting must never be blocked mid-shift. The report carries a full
// diagnostic context (page, user, timezone, browser, recent console logs,
// correlation id) so it can be actioned without asking the user anything else.
export async function POST(req: Request) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const userId = toObjectId(session.user.id);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { description, url, context } = (body || {}) as { description?: unknown; url?: unknown; context?: unknown };

  const text = typeof description === "string" ? description.trim() : "";
  if (!text) return Response.json({ error: "description is required" }, { status: 400 });
  if (text.length > MAX_DESCRIPTION) {
    return Response.json({ error: `description must be at most ${MAX_DESCRIPTION} characters` }, { status: 400 });
  }

  const correlationId = req.headers.get("x-correlation-id")?.slice(0, 200) || null;
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = cleanStr(forwarded || req.headers.get("x-real-ip"));

  const doc: ProblemReport = {
    description: text,
    url: cleanStr(url),
    referer: cleanStr(req.headers.get("referer")),
    ua: cleanStr(req.headers.get("user-agent"), 1000),
    ip,
    context: cleanContext(context),
    role: session.user.role,
    performedBy: userId,
    status: "open",
    correlationId,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: new Date(),
  };

  const db = await getDb();
  const res = await db.collection<ProblemReport>("problemReports").insertOne(doc);

  logger.info("problem_report.created", "Staff problem report filed", {
    reportId: res.insertedId.toString(),
    reporterId: session.user.id,
    reporterRole: session.user.role,
    correlationId: correlationId || undefined,
    status: "open",
  });

  return Response.json({ _id: res.insertedId, ...doc }, { status: 201 });
}

// GET /api/problem-reports — resident/admin only. Latest first, with the
// reporter's name/email/loginId joined in (same pattern as /api/audit-log).
export async function GET(req: Request) {
  const session = await requireRole(["resident", "admin"]);
  if (!session) return Response.json({ error: "Resident or admin only" }, { status: 403 });

  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100"), 500);
  const status = url.searchParams.get("status");
  const onlyOpen = url.searchParams.get("onlyOpen");

  const filter: { status?: "open" | "resolved" } = {};
  if (status === "open" || status === "resolved") filter.status = status;
  else if (onlyOpen === "true") filter.status = "open";

  const db = await getDb();
  const reports = await db
    .collection<ProblemReport>("problemReports")
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();

  const userIds = [...new Set(reports.map((r) => r.performedBy.toString()))];
  const users = userIds.length
    ? await db.collection("users").find({ _id: { $in: userIds.map((id) => new ObjectId(id)) } }).toArray()
    : [];
  const userMap = new Map(users.map((u: any) => [u._id.toString(), u]));

  return Response.json(
    reports.map((r) => {
      const u = userMap.get(r.performedBy.toString());
      return {
        ...r,
        performedByName: u?.fullName || "Unknown",
        performedByEmail: u?.email ?? u?.loginId ?? null,
        performedByLoginId: u?.loginId ?? null,
      };
    })
  );
}
