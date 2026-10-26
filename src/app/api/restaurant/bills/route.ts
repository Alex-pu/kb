import { NextResponse } from "next/server";
import type { QueryResultRow } from "pg";
import { assertOutletAccess, getAuthContext, hasPermission } from "@/lib/auth/require-session";
import { databaseReady, withUserContext } from "@/lib/db/postgres";
import type { CatalogItem, KotStatus, ShiftPeriod } from "@/lib/types/database";

export const runtime = "nodejs";

interface BillLine {
  item: CatalogItem;
  quantity: number;
  round: number;
  sentToKitchen: boolean;
  instructions?: string;
}

interface KitchenTicketSummary {
  station: "kitchen" | "bar";
  round: number;
  status: KotStatus;
}

interface BillRow extends QueryResultRow {
  id: string;
  bill_number: string;
  waiter_id: string;
  waiter_name: string;
  cashier_name: string;
  table_ref: string;
  table_name: string;
  business_date: string;
  shift_period: ShiftPeriod | null;
  status: "open" | "settled" | "voided";
  room_charge_pending: boolean;
  room_charge_request_id: string | null;
  room_charge_guest_name: string | null;
  payments: Array<{ type: string; amount: number; reference: string | null }>;
  lines: BillLine[];
  total: string;
  created_at: string;
  settled_at: string | null;
  kitchen_tickets: KitchenTicketSummary[];
  etims_status: "pending" | "submitted" | "failed" | "blocked" | "unknown" | null;
  etims_invoice_number: string | null;
  etims_scdc_id: string | null;
  etims_signature: string | null;
  etims_receipt_date: string | null;
  etims_receipt_number: string | null;
  etims_verification_url: string | null;
  etims_error: string | null;
}

function validDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export async function GET(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const outletId = params.get("outlet_id");
  const businessDate = params.get("business_date");
  if (!outletId || !validDate(businessDate)) {
    return NextResponse.json({ success: false, message: "A valid outlet_id and business_date are required." }, { status: 400 });
  }
  const scope = assertOutletAccess(auth.bundle, outletId);
  if (!scope) return NextResponse.json({ success: false, message: "You are not assigned to this outlet." }, { status: 403 });
  if (!hasPermission(auth.bundle, scope.propertyId, "restaurant:read")) {
    return NextResponse.json({ success: false, message: "You do not have permission to view restaurant bills." }, { status: 403 });
  }
  const canViewAll = hasPermission(auth.bundle, scope.propertyId, "users:manage") ||
    hasPermission(auth.bundle, scope.propertyId, "restaurant:settle");

  try {
    const result = await withUserContext(auth.userId, async (run) => {
      const bounds = await run<{ today: string; earliest_date: string }>(
        `SELECT (NOW() AT TIME ZONE 'Africa/Nairobi')::date::text AS today,
                ((NOW() AT TIME ZONE 'Africa/Nairobi')::date - INTERVAL '30 days')::date::text AS earliest_date`
      );
      const dateBounds = bounds.rows[0];
      if (businessDate > dateBounds.today) return { outcome: "future_date" as const };
      if (!canViewAll && businessDate < dateBounds.earliest_date) return { outcome: "outside_range" as const };

      const bills = await run<BillRow>(
        `SELECT rc.id, rc.bill_number, rc.waiter_id, waiter.full_name AS waiter_name,
                cashier.full_name AS cashier_name, rc.table_ref, rc.table_name,
                COALESCE(s.business_date, (rc.created_at AT TIME ZONE 'Africa/Nairobi')::date)::text AS business_date,
                s.shift_period, rc.status,
                (charge.id IS NOT NULL) AS room_charge_pending,
                charge.id AS room_charge_request_id,
                charge.guest_name AS room_charge_guest_name,
                COALESCE(
                  (SELECT jsonb_agg(jsonb_build_object(
                    'type', payment.tender_type,
                    'amount', payment.amount::float8,
                    'reference', payment.reference
                  ) ORDER BY payment.created_at)
                   FROM restaurant_check_payments payment
                   WHERE payment.check_id = rc.id),
                  '[]'::jsonb
                ) AS payments,
                rc.lines, rc.total, rc.created_at, rc.settled_at,
                etims.status AS etims_status, etims.invoice_number AS etims_invoice_number,
                etims.scdc_id AS etims_scdc_id, etims.invoice_signature AS etims_signature,
                etims.scu_receipt_date AS etims_receipt_date,
                etims.scu_receipt_number AS etims_receipt_number,
                etims.verification_url AS etims_verification_url, etims.error_message AS etims_error,
                COALESCE(
                  (SELECT jsonb_agg(
                    jsonb_build_object('station', kot.station, 'round', kot.round, 'status', kot.status)
                    ORDER BY kot.round, kot.station
                  )
                   FROM restaurant_kots kot
                   WHERE kot.check_id = rc.id),
                  '[]'::jsonb
                ) AS kitchen_tickets
         FROM restaurant_checks rc
         JOIN users waiter ON waiter.id = rc.waiter_id
         JOIN users cashier ON cashier.id = rc.cashier_id
         LEFT JOIN shifts s ON s.id = rc.shift_id
         LEFT JOIN restaurant_room_charge_requests charge
           ON charge.check_id = rc.id AND charge.status = 'pending'
         LEFT JOIN etims_submissions etims
           ON etims.restaurant_check_id = rc.id AND etims.property_id = rc.property_id
         WHERE rc.outlet_id = $1
           AND (
             COALESCE(s.business_date, (rc.created_at AT TIME ZONE 'Africa/Nairobi')::date) = $2::date
             OR charge.id IS NOT NULL
             OR rc.status = 'open'
           )
           AND ($3::boolean OR rc.waiter_id = $4)
         ORDER BY CASE
                    WHEN charge.id IS NOT NULL THEN 0
                    WHEN rc.status = 'open' THEN 1
                    ELSE 2
                  END,
                  rc.created_at DESC`,
        [outletId, businessDate, canViewAll, auth.userId]
      );
      return { outcome: "loaded" as const, bills: bills.rows };
    });

    if (result.outcome === "future_date") {
      return NextResponse.json({ success: false, message: "Bills cannot be queried for a future business date." }, { status: 400 });
    }
    if (result.outcome === "outside_range") {
      return NextResponse.json({ success: false, message: "Waiters can view bills from today and the previous 30 days only." }, { status: 403 });
    }
    return NextResponse.json({
      success: true,
      can_view_all: canViewAll,
      business_date: businessDate,
      bills: result.bills.map((row) => ({
        id: row.id,
        bill_number: row.bill_number,
        waiter_id: row.waiter_id,
        waiter_name: row.waiter_name,
        cashier_name: row.cashier_name,
        table_id: row.table_ref,
        table_name: row.table_name,
        business_date: row.business_date,
        shift_period: row.shift_period,
        status: row.status,
        room_charge_pending: row.room_charge_pending,
        room_charge_request_id: row.room_charge_request_id,
        room_charge_guest_name: row.room_charge_guest_name,
        payments: row.payments,
        lines: row.lines,
        total: Number(row.total),
        created_at: row.created_at,
        settled_at: row.settled_at,
        kitchen_tickets: row.kitchen_tickets,
        etims_status: row.etims_status,
        etims_invoice_number: row.etims_invoice_number,
        etims_scdc_id: row.etims_scdc_id,
        etims_signature: row.etims_signature,
        etims_receipt_date: row.etims_receipt_date,
        etims_receipt_number: row.etims_receipt_number,
        etims_verification_url: row.etims_verification_url,
        etims_error: row.etims_error,
      })),
    });
  } catch (error) {
    console.error("Failed to load restaurant bill history.", error);
    return NextResponse.json({ success: false, message: "Restaurant bill history could not be loaded." }, { status: 500 });
  }
}
