// Standard error/response plumbing (spec 16.5): services communicate failure by
// throwing HttpError with the exact status + message the frontend expects, and
// handleRoute turns it into the canonical { error } JSON body. A single wrapper
// also means unexpected exceptions become a consistent 500 instead of an
// inconsistent Next.js default.

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

// Wrap a route handler body. HttpError → its status/message; anything else is
// logged and becomes a 500. Auth guards stay in the route (before the handler),
// so their explicit 401/403 responses are unchanged.
export async function handleRoute(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) return jsonError(err.message, err.status, err.details);
    console.error("[route]", err);
    return jsonError("Internal server error", 500);
  }
}
