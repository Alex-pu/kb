import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { databaseReady, query } from "@/lib/db/postgres";
import { CashierOutletSessionConflictError, cashierOutletIdsForUser, createSession, findUserByIdentifier, getUserBundle } from "@/lib/db/auth-repository";
import { SESSION_COOKIE_NAME, SESSION_TTL_MS } from "@/lib/auth/session";
import { clearPinFailures, isPinAttemptLocked, pinAttemptKey, recordPinFailure } from "@/lib/auth/pin-attempts";

export const runtime = "nodejs";

const DUMMY_HASH = "$2a$12$CwTycUXWue0Thq9StjUM0uJ8jSwgPKCpRDJzEJGzRz2U..XVOtDJa";

export async function POST(request: Request) {
  if (!databaseReady()) {
    return NextResponse.json({ success: false, message: "DATABASE_URL is not configured on the server." }, { status: 503 });
  }

  let body: { identifier?: unknown; password?: unknown; pin?: unknown };
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return NextResponse.json({ success: false, message: "Request body must be a JSON object." }, { status: 400 });
    }
    body = parsed as { identifier?: unknown; password?: unknown; pin?: unknown };
  } catch {
    return NextResponse.json({ success: false, message: "Request body must be valid JSON." }, { status: 400 });
  }

  const identifier = typeof body.identifier === "string" ? body.identifier.trim() : "";
  const pinLogin = body.pin !== undefined;
  if (!identifier || (pinLogin && body.password !== undefined)) {
    return NextResponse.json({ success: false, message: "Enter your email/phone and one sign-in credential." }, { status: 400 });
  }

  let userRow: Awaited<ReturnType<typeof findUserByIdentifier>>;
  if (pinLogin) {
    const pin = typeof body.pin === "string" ? body.pin : "";
    if (!/^\d{4}$/.test(pin)) {
      return NextResponse.json({ success: false, message: "Enter your four-digit staff PIN." }, { status: 400 });
    }
    let attemptKey: string;
    try {
      userRow = await findUserByIdentifier(identifier);
      attemptKey = pinAttemptKey(userRow ? `user:${userRow.id}` : `identifier:${identifier.trim().toLowerCase().replace(/\s+/g, "")}`);
      if (await isPinAttemptLocked(attemptKey)) {
        return NextResponse.json({ success: false, message: "Too many incorrect PIN attempts. Try again in 15 minutes or use your password." }, { status: 429 });
      }
      const pinOk = await bcrypt.compare(pin, userRow?.pin_hash ?? DUMMY_HASH);
      if (!userRow || !userRow.is_active || !pinOk) {
        const locked = await recordPinFailure(attemptKey);
        return NextResponse.json({
          success: false,
          message: locked
            ? "Too many incorrect PIN attempts. Try again in 15 minutes or use your password."
            : "Invalid credentials.",
        }, { status: locked ? 429 : 401 });
      }
      await clearPinFailures(attemptKey);
    } catch (error) {
      console.error("Staff PIN authentication failed.", error);
      return NextResponse.json({ success: false, message: "PIN sign-in is temporarily unavailable." }, { status: 503 });
    }
  } else {
    const password = typeof body.password === "string" ? body.password : "";
    if (!password) {
      return NextResponse.json({ success: false, message: "Enter your email/phone and password." }, { status: 400 });
    }
    userRow = await findUserByIdentifier(identifier);
    const passwordOk = await bcrypt.compare(password, userRow?.password_hash ?? DUMMY_HASH);
    if (!userRow || !userRow.is_active || !passwordOk) {
      return NextResponse.json({ success: false, message: "Invalid credentials." }, { status: 401 });
    }
  }

  const bundle = await getUserBundle(userRow.id);
  if (!bundle || bundle.assignments.length === 0) {
    return NextResponse.json({ success: false, message: "This account has no active property assignment. Ask an administrator to assign you a role." }, { status: 403 });
  }

  const forwardedFor = request.headers.get("x-forwarded-for");
  const ipAddress = forwardedFor?.split(",")[0]?.trim() || null;
  const userAgent = request.headers.get("user-agent");

  let session: Awaited<ReturnType<typeof createSession>>;
  try {
    session = await createSession(userRow.id, bundle.company.id, ipAddress, userAgent, cashierOutletIdsForUser(bundle));
  } catch (error) {
    if (error instanceof CashierOutletSessionConflictError) {
      return NextResponse.json({
        success: false,
        message: "A cashier session is already active for one of your assigned outlets. Sign out the active session before signing in here.",
      }, { status: 409 });
    }
    throw error;
  }

  const response = NextResponse.json({ success: true, ...bundle });
  response.cookies.set(SESSION_COOKIE_NAME, session.cookieValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: session.expiresAt,
    maxAge: SESSION_TTL_MS / 1000,
  });
  return response;
}
