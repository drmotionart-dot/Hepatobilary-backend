import { SignJWT } from "jose";

// Signed-token issuance for the split frontend/backend setup. The frontend
// never shares session storage with this app — it receives this token at
// login and presents it as `Authorization: Bearer <token>` on every request.

// Validate the signing secret lazily — at first use, never at module import.
// next build evaluates route modules during page-data collection, so a missing
// secret at import time would fail every env-less build. Signing only happens
// at request time in a real deployment where the env var is set.
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

export const TOKEN_TTL_SECONDS = 8 * 60 * 60; // 8h, matches a work day + night shift

export async function signToken(payload: {
  sub: string;
  role: string;
  name?: string;
  email?: string;
  mustChangePassword?: boolean;
}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + TOKEN_TTL_SECONDS)
    .sign(getSecretKey());
}
