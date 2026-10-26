import { createHmac } from "node:crypto";
import { query } from "@/lib/db/postgres";

export const PIN_FAILURE_LIMIT = 5;

export function pinAttemptKey(identifier: string) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) throw new Error("SESSION_SECRET is not configured.");
  return createHmac("sha256", secret).update(identifier).digest("hex");
}

export async function isPinAttemptLocked(identifierHash: string) {
  const result = await query<{ locked: boolean }>(
    `SELECT COALESCE(locked_until > NOW(), FALSE) AS locked
     FROM auth_pin_login_attempts WHERE identifier_hash = $1`,
    [identifierHash],
  );
  return result.rows[0]?.locked ?? false;
}

export async function recordPinFailure(identifierHash: string) {
  const result = await query<{ locked: boolean }>(
    `INSERT INTO auth_pin_login_attempts AS attempts
       (identifier_hash, failed_attempts, window_started_at)
     VALUES ($1, 1, NOW())
     ON CONFLICT (identifier_hash) DO UPDATE
     SET failed_attempts = CASE
           WHEN attempts.window_started_at < NOW() - INTERVAL '15 minutes'
             OR (attempts.locked_until IS NOT NULL AND attempts.locked_until <= NOW())
             THEN 1
           ELSE attempts.failed_attempts + 1
         END,
         window_started_at = CASE
           WHEN attempts.window_started_at < NOW() - INTERVAL '15 minutes'
             OR (attempts.locked_until IS NOT NULL AND attempts.locked_until <= NOW())
             THEN NOW()
           ELSE attempts.window_started_at
         END,
         locked_until = CASE
           WHEN CASE
             WHEN attempts.window_started_at < NOW() - INTERVAL '15 minutes'
               OR (attempts.locked_until IS NOT NULL AND attempts.locked_until <= NOW())
               THEN 1
             ELSE attempts.failed_attempts + 1
           END >= $2
             THEN NOW() + INTERVAL '15 minutes'
           ELSE NULL
         END,
         updated_at = NOW()
     RETURNING failed_attempts >= $2 AS locked`,
    [identifierHash, PIN_FAILURE_LIMIT],
  );
  return result.rows[0]?.locked === true;
}

export async function clearPinFailures(identifierHash: string) {
  await query("DELETE FROM auth_pin_login_attempts WHERE identifier_hash = $1", [identifierHash]);
}
