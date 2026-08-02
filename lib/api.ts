import "@/lib/tz";
import { headers } from "next/headers";
import { jwtVerify } from "jose";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";
import type { Role, Capability } from "@/lib/models/types";

// Server-side auth for the split setup. Every protected route reads the JWT
// from the `Authorization: Bearer <token>` header (no cookies/sessions), so
// the frontend and backend can live on separate origins.

// Validate the signing secret lazily — at first use, never at module import.
// next build evaluates route modules during page-data collection, so a
// missing/weak secret at import time would fail EVERY env-less build (e.g.
// previews). With this, import always succeeds and a request that actually
// needs auth throws a clear error instead.
let jwtSecretKey: Uint8Array | null = null;
function getSecretKey(): Uint8Array {
  if (!jwtSecretKey) {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32 || secret.includes("replace-with-a-random")) {
      throw new Error("Missing or weak JWT_SECRET — copy .env.example to .env.local and set a random 32+ byte secret.");
    }
    jwtSecretKey = new TextEncoder().encode(secret);
  }
  return jwtSecretKey;
}

export interface AuthUser {
  id: string;
  role: Role;
  name: string;
  email: string;
  mustChangePassword: boolean;
}

export interface AuthSession {
  user: AuthUser;
}

// A flagged user (mustChangePassword=true) is blocked from everything except
// the password-change flow itself. requireSession() returns null for them so
// every existing caller (401 / redirect to login) behaves correctly, and the
// frontend middleware sends them to /change-password. The one route that must
// stay reachable is /api/change-password → pass { mustChangePasswordOK: true }.
export async function requireSession(opts?: { mustChangePasswordOK?: boolean }): Promise<AuthSession | null> {
  const h = await headers();
  const auth = h.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, getSecretKey(), { algorithms: ["HS256"] });
    if (!payload.sub) return null;
    const mustChangePassword = Boolean(payload.mustChangePassword);
    if (mustChangePassword && !opts?.mustChangePasswordOK) return null;
    return {
      user: {
        id: payload.sub,
        role: (payload.role as Role) || "intern",
        name: (payload.name as string) || "",
        email: (payload.email as string) || "",
        mustChangePassword,
      },
    };
  } catch {
    return null;
  }
}

export async function requireRole(roles: Role[], opts?: { mustChangePasswordOK?: boolean }): Promise<AuthSession | null> {
  const session = await requireSession(opts);
  if (!session?.user) return null;
  const role = session.user.role as Role;
  if (!roles.includes(role)) return null;
  return session;
}

// Granular capability gate (spec 11.7): admins and residents always pass;
// interns pass only when their (DB-fresh) grantedCapabilities include `cap`.
// Reads the user fresh so a grant takes effect immediately, no re-login needed.
export async function requireCapability(cap: Capability, opts?: { mustChangePasswordOK?: boolean }): Promise<AuthSession | null> {
  const session = await requireSession(opts);
  if (!session?.user) return null;
  const role = session.user.role;
  if (role === "admin" || role === "resident") return session;
  if (role !== "intern") return null;
  try {
    const db = await getDb();
    const user = await db.collection("users").findOne({ _id: toObjectId(session.user.id) }, { projection: { grantedCapabilities: 1 } });
    const caps: unknown[] = user?.grantedCapabilities ?? [];
    if (!Array.isArray(caps) || !caps.includes(cap)) return null;
    return session;
  } catch {
    return null;
  }
}

export function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

export function toObjectId(id: string) {
  return new ObjectId(id);
}

export function isValidObjectId(id: unknown): id is string {
  return typeof id === "string" && /^[a-fA-F0-9]{24}$/.test(id);
}
