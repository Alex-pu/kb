import { NextResponse } from "next/server";
import { databaseReady, withUserContext } from "@/lib/db/postgres";
import { getAuthContext, hasPermission } from "@/lib/auth/require-session";
import type { QueryResultRow } from "pg";

export const runtime = "nodejs";

interface AuditRow extends QueryResultRow {
  id: string;
  property_id: string | null;
  action_type: string;
  resource_type: string;
  resource_id: string | null;
  payload_after: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
  actor_name: string | null;
}

/**
 * Returns the append-only audit trail for the caller's company, newest first.
 * Restricted to callers with audit:read or a wildcard permission.
 */
export async function GET(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });

  const propertyIds = Array.from(new Set(auth.bundle.assignments
    .filter((assignment) => hasPermission(auth.bundle, assignment.property_id, "audit:read"))
    .map((assignment) => assignment.property_id)));
  if (propertyIds.length === 0) {
    return NextResponse.json({ success: false, message: "You do not have permission to view the audit trail." }, { status: 403 });
  }

  const propertyId = new URL(request.url).searchParams.get("property_id");
  if (propertyId && !propertyIds.includes(propertyId)) {
    return NextResponse.json({ success: false, message: "You do not have permission to view that property's audit trail." }, { status: 403 });
  }
  const limit = 200;

  const rows = await withUserContext(auth.userId, async (run) => {
    const result = await run<AuditRow>(
      propertyId
        ? `SELECT al.id, al.property_id, al.action_type, al.resource_type, al.resource_id, al.payload_after, al.ip_address, al.created_at, u.full_name AS actor_name
           FROM audit_log al
           LEFT JOIN users u ON u.id = al.actor_user_id
           WHERE al.company_id = $1 AND al.property_id = $2
           ORDER BY al.created_at DESC
           LIMIT $3`
        : `SELECT al.id, al.property_id, al.action_type, al.resource_type, al.resource_id, al.payload_after, al.ip_address, al.created_at, u.full_name AS actor_name
           FROM audit_log al
           LEFT JOIN users u ON u.id = al.actor_user_id
           WHERE al.company_id = $1 AND al.property_id = ANY($2::uuid[])
           ORDER BY al.created_at DESC
           LIMIT $2`,
      propertyId ? [auth.bundle.company.id, propertyId, limit] : [auth.bundle.company.id, propertyIds, limit]
    );
    return result.rows;
  });

  return NextResponse.json({
    success: true,
    logs: rows.map((row) => ({
      id: row.id,
      property_id: row.property_id,
      action_type: row.action_type,
      resource_type: row.resource_type,
      resource_id: row.resource_id,
      payload_after: row.payload_after,
      ip_address: row.ip_address,
      created_at: row.created_at,
      actor_name: row.actor_name ?? "System",
    })),
  });
}
