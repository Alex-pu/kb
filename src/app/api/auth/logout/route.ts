import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth/session";
import { revokeSession } from "@/lib/db/auth-repository";
import { databaseReady } from "@/lib/db/postgres";

export const runtime = "nodejs";

export async function POST() {
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const sessionId = verifySessionToken(cookieValue);

  if (sessionId && databaseReady()) {
    await revokeSession(sessionId);
  }

  const response = NextResponse.json({ success: true });
  response.cookies.set(SESSION_COOKIE_NAME, "", { httpOnly: true, path: "/", maxAge: 0 });
  return response;
}
