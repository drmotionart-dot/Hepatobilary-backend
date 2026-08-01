import { SignJWT } from "jose";

// Signed-token issuance for the split frontend/backend setup. The frontend
// never shares session storage with this app — it receives this token at
// login and presents it as `Authorization: Bearer <token>` on every request.

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET.length < 32 || JWT_SECRET.includes("replace-with-a-random")) {
  throw new Error("Missing or weak JWT_SECRET — copy .env.example to .env.local and set a random 32+ byte secret.");
}
const secretKey = new TextEncoder().encode(JWT_SECRET);

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
    .sign(secretKey);
}
