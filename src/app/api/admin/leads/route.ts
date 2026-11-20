import { NextResponse } from "next/server";
import type { QueryResultRow } from "pg";
import { getAuthContext } from "@/lib/auth/require-session";
import { databaseReady, query } from "@/lib/db/postgres";

export const runtime = "nodejs";

interface LeadRow extends QueryResultRow {
  id: string;
  full_name: string;
  phone: string;
  organization: string;
  email: string;
  plan: string;
  preferred_demo_at: string;
  message: string | null;
  created_at: string;
}

export async function GET(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });
  if (!auth.bundle.user.is_super_admin) return NextResponse.json({ success: false, message: "Only a platform super admin can view leads." }, { status: 403 });

  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || "100"), 1), 500);
  const result = await query<LeadRow>(
    `SELECT id, full_name, phone, organization, email, plan, preferred_demo_at, message, created_at
     FROM marketing_leads
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit],
  );
  return NextResponse.json({ success: true, leads: result.rows });
}
