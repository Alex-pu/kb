import crypto from "crypto";

export const SESSION_COOKIE_NAME = "kb_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("SESSION_SECRET is not configured. Set a strong random value in .env.local.");
  }
  return secret;
}

/**
 * Generates a random session id + a signed cookie value. The raw session id is
 * what we store (hashed) in the `sessions` table so a leaked cookie can be
 * revoked server-side; the signature lets us reject tampered cookies cheaply
 * before even hitting the database.
 */
export function createSessionToken(): { sessionId: string; cookieValue: string } {
  const sessionId = crypto.randomBytes(32).toString("hex");
  const signature = sign(sessionId);
  return { sessionId, cookieValue: `${sessionId}.${signature}` };
}

export function sign(value: string): string {
  return crypto.createHmac("sha256", getSessionSecret()).update(value).digest("hex");
}

/**
 * Verifies the HMAC signature on a cookie value and returns the embedded
 * session id if valid. This does NOT check the database (expiry/revocation) —
 * callers must still look the session id up in the `sessions` table.
 */
export function verifySessionToken(cookieValue: string | undefined | null): string | null {
  if (!cookieValue) return null;
  const [sessionId, signature] = cookieValue.split(".");
  if (!sessionId || !signature) return null;
  const expected = sign(sessionId);
  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return sessionId;
}

/** Hashes a session id for storage/lookup in the `sessions.token_hash` column. */
export function hashSessionId(sessionId: string): string {
  return crypto.createHash("sha256").update(sessionId).digest("hex");
}
