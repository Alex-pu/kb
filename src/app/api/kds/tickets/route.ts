import { NextResponse } from "next/server";
import type { QueryResultRow } from "pg";
import { assertOutletAccess, getAuthContext, hasPermission } from "@/lib/auth/require-session";
import { databaseReady, withUserContext } from "@/lib/db/postgres";
import type { Kot, KotStatus } from "@/lib/types/database";

export const runtime = "nodejs";

interface KotRow extends QueryResultRow {
  id: string;
  check_id: string;
  table_ref: string;
  table_name: string;
  round: number;
  station: "kitchen" | "bar";
  status: KotStatus;
  lines: Kot["lines"];
  created_at: string;
  cancel_reason: string | null;
  check_status?: "open" | "settled" | "voided";
}

interface TicketRequest {
  outlet_id?: unknown;
  ticket_id?: unknown;
  next_status?: unknown;
  reason?: unknown;
}

const LEGAL_TRANSITIONS: Record<KotStatus, KotStatus[]> = {
  new: ["accepted", "cancelled"],
  accepted: ["preparing", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["served"],
  served: [],
  cancelled: [],
};

function ticketDto(row: KotRow): Kot {
  return {
    id: row.id,
    check_id: row.check_id,
    table_id: row.table_ref,
    table_name: row.table_name,
    round: row.round,
    station: row.station,
    status: row.status,
    lines: row.lines,
    created_at: row.created_at,
    cancel_reason: row.cancel_reason ?? undefined,
  };
}

async function readBody(request: Request): Promise<TicketRequest | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null ? body as TicketRequest : null;
  } catch {
    return null;
  }
}

function validStatus(status: unknown): status is KotStatus {
  return status === "new" || status === "accepted" || status === "preparing" ||
    status === "ready" || status === "served" || status === "cancelled";
}

export async function GET(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });

  const outletId = new URL(request.url).searchParams.get("outlet_id");
  if (!outletId) return NextResponse.json({ success: false, message: "outlet_id is required." }, { status: 400 });
  const scope = assertOutletAccess(auth.bundle, outletId);
  if (!scope) return NextResponse.json({ success: false, message: "You are not assigned to this outlet." }, { status: 403 });
  if (!hasPermission(auth.bundle, scope.propertyId, "kds:read") &&
      !hasPermission(auth.bundle, scope.propertyId, "restaurant:read")) {
    return NextResponse.json({ success: false, message: "You do not have permission to view kitchen tickets." }, { status: 403 });
  }

  try {
    const tickets = await withUserContext(auth.userId, async (run) => {
      const result = await run<KotRow>(
        `SELECT kot.id, kot.check_id, kot.table_ref, kot.table_name, kot.round,
                kot.station, kot.status, kot.lines, kot.created_at, kot.cancel_reason
         FROM restaurant_kots kot
         JOIN restaurant_checks rc ON rc.id = kot.check_id
         WHERE kot.outlet_id = $1 AND kot.archived_at IS NULL
           AND kot.status NOT IN ('served', 'cancelled')
         ORDER BY kot.created_at, kot.station`,
        [outletId]
      );
      return result.rows.map(ticketDto);
    });
    return NextResponse.json({ success: true, tickets });
  } catch (error) {
    console.error("Failed to load kitchen tickets.", error);
    return NextResponse.json({ success: false, message: "Kitchen tickets could not be loaded." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });
  const body = await readBody(request);
  if (!body) return NextResponse.json({ success: false, message: "Request body must be a valid JSON object." }, { status: 400 });

  const outletId = typeof body.outlet_id === "string" ? body.outlet_id : "";
  const ticketId = typeof body.ticket_id === "string" ? body.ticket_id : "";
  const nextStatus = body.next_status;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!outletId || !ticketId || !validStatus(nextStatus) ||
      (body.reason !== undefined && (typeof body.reason !== "string" || reason.length > 500))) {
    return NextResponse.json({ success: false, message: "A valid outlet, ticket, status, and cancellation reason are required." }, { status: 400 });
  }

  const scope = assertOutletAccess(auth.bundle, outletId);
  if (!scope) return NextResponse.json({ success: false, message: "You are not assigned to this outlet." }, { status: 403 });
  if (!hasPermission(auth.bundle, scope.propertyId, "kds:manage")) {
    return NextResponse.json({ success: false, message: "You do not have permission to manage kitchen tickets." }, { status: 403 });
  }
  if (nextStatus === "cancelled" && !reason) {
    return NextResponse.json({ success: false, message: "A cancellation reason is required." }, { status: 400 });
  }

  try {
    const result = await withUserContext(auth.userId, async (run) => {
      const selected = await run<KotRow>(
        `SELECT kot.id, kot.check_id, kot.table_ref, kot.table_name, kot.round,
                kot.station, kot.status, kot.lines, kot.created_at, kot.cancel_reason,
                rc.status AS check_status
         FROM restaurant_kots kot
         JOIN restaurant_checks rc ON rc.id = kot.check_id
         WHERE kot.id = $1 AND kot.outlet_id = $2 AND kot.archived_at IS NULL
         FOR UPDATE OF rc, kot`,
        [ticketId, outletId]
      );
      const ticket = selected.rows[0];
      if (!ticket) return { outcome: "not_found" as const };
      if (!LEGAL_TRANSITIONS[ticket.status].includes(nextStatus)) {
        return { outcome: "invalid_transition" as const, status: ticket.status };
      }

      const updated = await run<KotRow>(
        `UPDATE restaurant_kots
         SET status = $1, cancel_reason = $2, updated_at = NOW(),
             archived_at = CASE WHEN $1 IN ('served', 'cancelled') AND $4 = 'settled' THEN NOW() ELSE archived_at END
         WHERE id = $3
         RETURNING id, check_id, table_ref, table_name, round, station, status, lines, created_at, cancel_reason`,
        [nextStatus, nextStatus === "cancelled" ? reason : null, ticketId, ticket.check_status]
      );
      await run(
        `INSERT INTO audit_log (company_id, property_id, outlet_id, actor_user_id, action_type, resource_type, resource_id, payload_after)
         VALUES ($1, $2, $3, $4, $5, 'restaurant_kots', $6, $7::jsonb)`,
        [
          auth.bundle.company.id,
          scope.propertyId,
          outletId,
          auth.userId,
          nextStatus === "cancelled" ? "KOT.CANCEL" : "KOT.STATUS",
          ticketId,
          JSON.stringify({ from: ticket.status, to: nextStatus, reason: nextStatus === "cancelled" ? reason : undefined }),
        ]
      );
      return { outcome: "updated" as const, ticket: ticketDto(updated.rows[0]) };
    });

    if (result.outcome === "not_found") return NextResponse.json({ success: false, message: "Active kitchen ticket not found." }, { status: 404 });
    if (result.outcome === "invalid_transition") {
      return NextResponse.json({ success: false, message: `Cannot move ticket from ${result.status} to ${nextStatus}.` }, { status: 409 });
    }
    return NextResponse.json({ success: true, message: `Ticket moved to ${nextStatus}.`, ticket: result.ticket });
  } catch (error) {
    console.error("Failed to update kitchen ticket.", error);
    return NextResponse.json({ success: false, message: "Kitchen ticket status was not changed." }, { status: 500 });
  }
}
