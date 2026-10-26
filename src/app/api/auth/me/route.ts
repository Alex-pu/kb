import { NextResponse } from "next/server";
import { databaseReady } from "@/lib/db/postgres";
import { getAuthContext } from "@/lib/auth/require-session";

export const runtime = "nodejs";

export async function GET() {
  if (!databaseReady()) {
    return NextResponse.json({ success: false, message: "DATABASE_URL is not configured on the server." }, { status: 503 });
  }

  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });
  }

  return NextResponse.json({ success: true, ...auth.bundle });
}
