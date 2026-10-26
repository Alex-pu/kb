import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/require-session";
import { isPinAttemptLocked, pinAttemptKey, recordPinFailure, clearPinFailures } from "@/lib/auth/pin-attempts";
import { hashSessionId, SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth/session";
import { databaseReady, withUserContext } from "@/lib/db/postgres";

export const runtime = "nodejs";

const DUMMY_HASH = "$2a$12$CwTycUXWue0Thq9StjUM0uJ8jSwgPKCpRDJzEJGzRz2U..XVOtDJa";

interface CredentialRequest {
  current_password?: unknown;
  current_pin?: unknown;
  new_password?: unknown;
  new_pin?: unknown;
  clear_pin?: unknown;
}

async function readBody(request: Request): Promise<CredentialRequest | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? body as CredentialRequest
      : null;
  } catch {
    return null;
  }
}

export async function GET() {
  if (!databaseReady()) {
    return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  }
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });

  try {
    const result = await withUserContext(auth.userId, (run) =>
      run<{ pin_enabled: boolean }>(
        `SELECT pin_hash IS NOT NULL AS pin_enabled FROM users WHERE id = $1`,
        [auth.userId],
      )
    );
    if (!result.rows[0]) return NextResponse.json({ success: false, message: "Account not found." }, { status: 404 });
    return NextResponse.json({ success: true, pin_enabled: result.rows[0].pin_enabled });
  } catch (error) {
    console.error("Failed to load account credential settings.", error);
    return NextResponse.json({ success: false, message: "Account settings could not be loaded." }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  if (!databaseReady()) {
    return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  }
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });

  const body = await readBody(request);
  if (!body) return NextResponse.json({ success: false, message: "Request body must be a valid JSON object." }, { status: 400 });

  const currentPassword = typeof body.current_password === "string" ? body.current_password : "";
  const currentPin = typeof body.current_pin === "string" ? body.current_pin : "";
  const newPassword = typeof body.new_password === "string" ? body.new_password : "";
  const newPin = typeof body.new_pin === "string" ? body.new_pin : "";
  const clearPin = body.clear_pin === true;
  const hasCurrentPassword = body.current_password !== undefined;
  const hasCurrentPin = body.current_pin !== undefined;
  const hasNewPassword = body.new_password !== undefined && newPassword !== "";
  const hasNewPin = body.new_pin !== undefined && newPin !== "";

  if (hasCurrentPassword === hasCurrentPin || (!hasNewPassword && !hasNewPin && !clearPin) ||
      (hasNewPassword && (newPassword.length < 12 || newPassword.length > 128)) ||
      (hasNewPin && !/^\d{4}$/.test(newPin)) ||
      (clearPin && (hasNewPin || body.clear_pin !== true)) ||
      (body.new_password !== undefined && typeof body.new_password !== "string") ||
      (body.new_pin !== undefined && typeof body.new_pin !== "string") ||
      (body.clear_pin !== undefined && typeof body.clear_pin !== "boolean")) {
    return NextResponse.json({
      success: false,
      message: "Confirm your current password or PIN, then provide a password of at least 12 characters and/or a four-digit PIN.",
    }, { status: 400 });
  }
  if (hasCurrentPassword && (!currentPassword || currentPassword.length > 128)) {
    return NextResponse.json({ success: false, message: "Enter your current password." }, { status: 400 });
  }
  if (hasCurrentPin && !/^\d{4}$/.test(currentPin)) {
    return NextResponse.json({ success: false, message: "Enter your current four-digit PIN." }, { status: 400 });
  }

  const attemptKey = pinAttemptKey(`user:${auth.userId}`);
  try {
    if (await isPinAttemptLocked(attemptKey)) {
      return NextResponse.json({ success: false, message: "Too many incorrect credential attempts. Try again in 15 minutes." }, { status: 429 });
    }

    const credentialResult = await withUserContext(auth.userId, (run) =>
      run<{ company_id: string; password_hash: string; pin_hash: string | null }>(
        `SELECT company_id, password_hash, pin_hash FROM users WHERE id = $1 AND is_active = TRUE`,
        [auth.userId],
      )
    );
    const account = credentialResult.rows[0];
    if (!account) return NextResponse.json({ success: false, message: "Account not found or inactive." }, { status: 404 });

    const credentialHash = hasCurrentPassword ? account.password_hash : account.pin_hash ?? DUMMY_HASH;
    const credentialValue = hasCurrentPassword ? currentPassword : currentPin;
    const credentialIsValid = await bcrypt.compare(credentialValue, credentialHash);
    if (!credentialIsValid) {
      const locked = await recordPinFailure(attemptKey);
      return NextResponse.json({
        success: false,
        message: locked
          ? "Too many incorrect credential attempts. Try again in 15 minutes."
          : "Your current password or PIN is incorrect.",
      }, { status: locked ? 429 : 401 });
    }
    await clearPinFailures(attemptKey);

    const passwordHash = hasNewPassword ? await bcrypt.hash(newPassword, 12) : null;
    const pinHash = hasNewPin ? await bcrypt.hash(newPin, 12) : null;
    const cookieStore = await cookies();
    const sessionId = verifySessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value);
    if (!sessionId) return NextResponse.json({ success: false, message: "Your session is no longer valid. Sign in again." }, { status: 401 });
    const currentTokenHash = hashSessionId(sessionId);

    await withUserContext(auth.userId, async (run) => {
      const update = await run(
        `UPDATE users
         SET password_hash = COALESCE($1, password_hash),
             pin_hash = CASE WHEN $2 THEN NULL WHEN $3::varchar IS NOT NULL THEN $3::varchar ELSE pin_hash END,
             updated_at = NOW()
         WHERE id = $4 AND is_active = TRUE`,
        [passwordHash, clearPin, pinHash, auth.userId],
      );
      if (update.rowCount !== 1) throw new Error("Account credential update did not affect exactly one active user.");

      const revoked = await run(
        `UPDATE sessions SET revoked_at = NOW()
         WHERE user_id = $1 AND token_hash <> $2 AND revoked_at IS NULL
         RETURNING id`,
        [auth.userId, currentTokenHash],
      );
      if (revoked.rows.length) {
        await run(
          `DELETE FROM cashier_outlet_sessions WHERE user_id = $1 AND session_id = ANY($2::uuid[])`,
          [auth.userId, revoked.rows.map((session) => session.id)],
        );
      }
      await run(
        `INSERT INTO audit_log (company_id, actor_user_id, action_type, resource_type, resource_id, payload_after)
         VALUES ($1, $2, 'USER.CREDENTIALS_UPDATE', 'users', $2, $3::jsonb)`,
        [
          account.company_id,
          auth.userId,
          JSON.stringify({
            password_changed: hasNewPassword,
            pin_changed: hasNewPin || clearPin,
            pin_enabled: clearPin ? false : hasNewPin ? true : account.pin_hash !== null,
          }),
        ],
      );
    });

    return NextResponse.json({
      success: true,
      message: "Credentials updated. This session remains signed in; other sessions were signed out.",
      pin_enabled: clearPin ? false : hasNewPin ? true : account.pin_hash !== null,
    });
  } catch (error) {
    console.error("Failed to update account credentials.", error);
    return NextResponse.json({ success: false, message: "Credentials could not be updated." }, { status: 500 });
  }
}
