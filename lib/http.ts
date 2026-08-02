// Standard error/response plumbing (spec 16.5): services communicate failure by
// throwing HttpError with the exact status + message the frontend expects, and
// handleRoute turns it into the canonical { error } JSON body. A single wrapper
// also means unexpected exceptions become a consistent 500 instead of an
// inconsistent Next.js default. handleRoute additionally emits a structured
// completion log line (status, duration, correlationId) so the middleware's
// request-entry trace can be closed end-to-end.

import { logger } from "@/lib/logger";

export class HttpError extends Error {
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function jsonError(message: string, status = 400, details?: Record<string, unknown>): Response {
  return Response.json({ error: message, ...(details ?? {}) }, { status });
}

function pathOf(req: Request): string {
  try {
    return new URL(req.url).pathname;
  } catch {
    return req.url || "unknown";
  }
}

// Wrap a route handler body. HttpError → its status/message; anything else is
// logged and becomes a 500. Auth guards stay in the route (before the handler),
// so their explicit 401/403 responses are unchanged.
export async function handleRoute(req: Request, fn: () => Promise<Response>): Promise<Response> {
  const startedAt = Date.now();
  const correlationId = req.headers.get("x-correlation-id") || "unknown";
  const path = pathOf(req);

  try {
    const res = await fn();
    logger.info("http_complete", `${req.method} ${path} -> ${res.status}`, {
      method: req.method,
      path,
      status: res.status,
      durationMs: Date.now() - startedAt,
      correlationId,
    });
    return res;
  } catch (err) {
    if (err instanceof HttpError) {
      // 4xx/409 are expected outcomes, not server faults — logged for traceability.
      logger.warn("http_error", `${req.method} ${path} -> ${err.status}: ${err.message}`, {
        method: req.method,
        path,
        status: err.status,
        durationMs: Date.now() - startedAt,
        correlationId,
      });
      return jsonError(err.message, err.status, { ...(err.details ?? {}), correlationId });
    }
    logger.error("http_error", `unhandled error on ${req.method} ${path}`, {
      method: req.method,
      path,
      status: 500,
      durationMs: Date.now() - startedAt,
      correlationId,
      err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
    });
    return jsonError("Internal server error", 500, { correlationId });
  }
}
