import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// CORS locked to the frontend's deployed origin(s) only (spec §2.1). The
// backend rejects preflight requests from any other origin, so the API can't
// be called from an unknown website in a browser. Server-to-server calls (the
// frontend's server components fetching with an Authorization header) carry no
// Origin header and pass through untouched.
//
// Correlation ID (spec 16.5): every API request gets an x-correlation-id — the
// client's is honoured, otherwise a fresh UUID is minted here. It rides on the
// request into the handler and on the response back out, so a user-reported
// failure can be matched to the exact server log line. Every request is also
// logged (JSON line) at entry for end-to-end traceability.

const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function correlationId(req: NextRequest): string {
  const incoming = req.headers.get("x-correlation-id");
  if (incoming) return incoming;
  return globalThis.crypto?.randomUUID?.() ?? `hpb-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function middleware(req: NextRequest) {
  const origin = req.headers.get("origin") || "";
  const originAllowed = allowedOrigins.includes(origin);
  const isPreflight = req.method === "OPTIONS";

  const id = correlationId(req);
  req.headers.set("x-correlation-id", id);

  const res = NextResponse.next();
  res.headers.set("x-correlation-id", id);

  if (originAllowed) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    res.headers.set("Vary", "Origin");
    // x-shift-key is sent on intern-gated writes; x-sync-replay + x-performed-at
    // on offline queue replays (spec 11.6); x-correlation-id is end-to-end
    // request tracing (spec 16.5). All must be allowed through preflight.
    res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, x-shift-key, x-sync-replay, x-performed-at, x-correlation-id");
    res.headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    res.headers.set("Access-Control-Max-Age", "86400");
  }

  // Edge runtime: console.log writes a JSON line without Node APIs.
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "http_request",
      message: `${req.method} ${req.nextUrl.pathname}`,
      method: req.method,
      path: req.nextUrl.pathname,
      correlationId: id,
    })
  );

  if (isPreflight) {
    if (originAllowed) {
      return new NextResponse(null, { status: 204, headers: res.headers });
    }
    return new NextResponse(null, { status: 403 });
  }

  return res;
}

export const config = {
  matcher: "/api/:path*",
};
