import { NextResponse } from "next/server";
import type { QueryResultRow } from "pg";
import { assertOutletAccess, getAuthContext, hasPermission } from "@/lib/auth/require-session";
import { databaseReady, withUserContext } from "@/lib/db/postgres";
import type { StockRequisition } from "@/lib/types/database";

export const runtime = "nodejs";

interface SupplyRow extends QueryResultRow {
  id: string;
  name: string;
  sku: string;
  unit: string;
}

interface RequestRow extends QueryResultRow {
  id: string;
  outlet_id: string;
  outlet_name: string;
  requester_id: string;
  requester_name: string;
  status: StockRequisition["status"];
  note: string | null;
  rejection_reason: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by_name: string | null;
  lines: StockRequisition["lines"];
}

export async function GET(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });

  const outletId = new URL(request.url).searchParams.get("outlet_id");
  if (!outletId) return NextResponse.json({ success: false, message: "outlet_id is required." }, { status: 400 });
  const scope = assertOutletAccess(auth.bundle, outletId);
  if (!scope) return NextResponse.json({ success: false, message: "You are not assigned to this outlet." }, { status: 403 });
  if (!hasPermission(auth.bundle, scope.propertyId, "inventory:request")) {
    return NextResponse.json({ success: false, message: "You do not have permission to request supplies." }, { status: 403 });
  }

  try {
    const data = await withUserContext(auth.userId, async (run) => {
      const [suppliesResult, requestsResult] = await Promise.all([
        run<SupplyRow>(
          `SELECT id, name, sku, unit
           FROM items
           WHERE property_id = $1 AND item_type = 'supply'
             AND stock_tracked = TRUE AND is_active = TRUE
           ORDER BY name`,
          [scope.propertyId]
        ),
        run<RequestRow>(
          `SELECT sr.id, sr.outlet_id, o.name AS outlet_name,
                  sr.requester_id, requester.full_name AS requester_name,
                  sr.status, sr.note, sr.rejection_reason, sr.created_at,
                  sr.resolved_at, resolver.full_name AS resolved_by_name,
                  COALESCE(
                    jsonb_agg(jsonb_build_object(
                      'item_id', srl.item_id,
                      'item_name', i.name,
                      'unit', i.unit,
                      'quantity_requested', srl.quantity_requested,
                      'quantity_fulfilled', srl.quantity_fulfilled
                    ) ORDER BY i.name) FILTER (WHERE srl.id IS NOT NULL),
                    '[]'::jsonb
                  ) AS lines
           FROM stock_requisitions sr
           JOIN outlets o ON o.id = sr.outlet_id
           JOIN users requester ON requester.id = sr.requester_id
           LEFT JOIN users resolver ON resolver.id = sr.resolved_by
           LEFT JOIN stock_requisition_lines srl ON srl.requisition_id = sr.id
           LEFT JOIN items i ON i.id = srl.item_id
           WHERE sr.outlet_id = $1 AND sr.requester_id = $2
             AND sr.destination_warehouse = 'supplies'
           GROUP BY sr.id, o.name, requester.full_name, resolver.full_name
           ORDER BY sr.created_at DESC
           LIMIT 100`,
          [outletId, auth.userId]
        ),
      ]);

      return {
        supplies: suppliesResult.rows,
        requests: requestsResult.rows.map((row) => ({
          id: row.id,
          outlet_id: row.outlet_id,
          outlet_name: row.outlet_name,
          destination_warehouse: "supplies" as const,
          requester_id: row.requester_id,
          requester_name: row.requester_name,
          status: row.status,
          note: row.note ?? undefined,
          rejection_reason: row.rejection_reason ?? undefined,
          created_at: row.created_at,
          resolved_at: row.resolved_at ?? undefined,
          resolved_by_name: row.resolved_by_name ?? undefined,
          lines: row.lines,
        } satisfies StockRequisition)),
      };
    });

    return NextResponse.json({ success: true, ...data });
  } catch (error) {
    console.error("Failed to load store requests.", error);
    return NextResponse.json({ success: false, message: "Store requests could not be loaded." }, { status: 500 });
  }
}
