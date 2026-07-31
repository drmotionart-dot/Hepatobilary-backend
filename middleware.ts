import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// CORS locked to the frontend's deployed origin(s) only (spec §2.1). The
// backend rejects preflight requests from any other origin, so the API can't
// be called from an unknown website in a browser. Server-to-server calls (the
// frontend's server components fetching with an Authorization header) carry no
// Origin header and pass through untouched.

const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function middleware(req: NextRequest) {
  const origin = req.headers.get("origin") || "";
  const originAllowed = allowedOrigins.includes(origin);
  const isPreflight = req.method === "OPTIONS";

  const res = NextResponse.next();

  if (originAllowed) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    res.headers.set("Vary", "Origin");
    res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    res.headers.set("Access-Control-Max-Age", "86400");
  }

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
