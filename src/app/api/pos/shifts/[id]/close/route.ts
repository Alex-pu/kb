import { NextResponse } from "next/server";
import { databaseReady, withUserContext } from "@/lib/db/postgres";
import { getAuthContext } from "@/lib/auth/require-session";
import { permissionGranted } from "@/lib/auth/permissions";
import type { ShiftArea, ShiftPeriod } from "@/lib/types/database";
import type { QueryResultRow } from "pg";

export const runtime = "nodejs";

interface ShiftRow extends QueryResultRow {
  id: string;
  property_id: string;
  outlet_id: string;
  station_id: string;
  cashier_id: string;
  shift_area: ShiftArea | null;
  shift_period: ShiftPeriod | null;
  business_date: string | null;
  opening_float: string;
  cash_sales: string;
  status: "open" | "closed";
  opened_at: string;
  closed_at: string | null;
  counted_cash: string | null;
  variance: string | null;
}

interface PendingRestaurantCheckRow extends QueryResultRow {
  id: string;
  table_name: string;
  waiter_name: string;
  total: string;
}

interface CloseShiftBody {
  counted_cash?: number;
  variance_threshold?: number;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });
  const authenticatedUser = auth;

  const { id } = await params;

  let body: CloseShiftBody;
  try {
    body = (await request.json()) as CloseShiftBody;
  } catch {
    return NextResponse.json({ success: false, message: "Request body must be valid JSON." }, { status: 400 });
  }

  if (typeof body.counted_cash !== "number" || body.counted_cash < 0) {
    return NextResponse.json({ success: false, message: "A non-negative counted_cash amount is required." }, { status: 400 });
  }

  let result: Awaited<ReturnType<typeof closeShift>>;
  async function closeShift() {
    return withUserContext(authenticatedUser.userId, async (run) => {
      const shiftResult = await run<ShiftRow>(`SELECT * FROM shifts WHERE id = $1 FOR UPDATE`, [id]);
      const shift = shiftResult.rows[0];
      if (!shift) return { outcome: "not_found" as const };
      if (shift.status !== "open") return { outcome: "already_closed" as const };
      if (shift.cashier_id !== authenticatedUser.userId) {
        return { outcome: "not_opener" as const };
      }

      const canClose = authenticatedUser.bundle.assignments
        .filter((assignment) =>
          assignment.property_id === shift.property_id &&
          (!assignment.outlet_id || assignment.outlet_id === shift.outlet_id) &&
          (!assignment.station_id || assignment.station_id === shift.station_id)
        )
        .some((assignment) => permissionGranted(assignment.role?.permissions ?? [], "shift:close"));
      if (!canClose) {
        return { outcome: "forbidden" as const };
      }

      const pendingChecksResult = await run<PendingRestaurantCheckRow>(
        `SELECT rc.id, rc.table_name, u.full_name AS waiter_name, rc.total
         FROM restaurant_checks rc
         JOIN users u ON u.id = rc.waiter_id
         WHERE rc.shift_id = $1 AND rc.status = 'open'
         ORDER BY u.full_name, rc.table_name
         LIMIT 50`,
        [shift.id]
      );
      if (pendingChecksResult.rows.length > 0) {
        return {
          outcome: "pending_restaurant_bills" as const,
          checks: pendingChecksResult.rows.map((check) => ({
            id: check.id,
            table_name: check.table_name,
            waiter_name: check.waiter_name,
            total: Number(check.total),
          })),
        };
      }

      const expectedCash = Number(shift.opening_float) + Number(shift.cash_sales);
      const variance = body.counted_cash! - expectedCash;
      const threshold = body.variance_threshold ?? 50;
      const requiresApproval = Math.abs(variance) > threshold;

      const updated = await run<ShiftRow>(
        `UPDATE shifts SET status = 'closed', closed_at = NOW(), counted_cash = $1, variance = $2 WHERE id = $3 RETURNING *`,
        [body.counted_cash, variance, id]
      );
      await run(
        `INSERT INTO audit_log (company_id, property_id, outlet_id, actor_user_id, action_type, resource_type, resource_id)
         VALUES ($1, $2, $3, $4, $5, 'shifts', $6)`,
        [
          authenticatedUser.bundle.company.id,
          updated.rows[0].property_id,
          updated.rows[0].outlet_id,
          authenticatedUser.userId,
          updated.rows[0].shift_area === "reservation" ? "RESERVATION_SHIFT.CLOSE" : "SHIFT.CLOSE",
          updated.rows[0].id,
        ]
      );
      return { outcome: "closed" as const, shift: updated.rows[0], requiresApproval, variance };
    });
  }
  try {
    result = await closeShift();
  } catch (error) {
    console.error("Failed to close cashier shift.", error);
    return NextResponse.json({ success: false, message: "The shift could not be closed. No close was recorded." }, { status: 500 });
  }

  if (result.outcome === "not_found") return NextResponse.json({ success: false, message: "Shift not found." }, { status: 404 });
  if (result.outcome === "already_closed") return NextResponse.json({ success: false, message: "This shift is already closed." }, { status: 409 });
  if (result.outcome === "not_opener") return NextResponse.json({ success: false, message: "Only the cashier who opened this shift can close it." }, { status: 403 });
  if (result.outcome === "forbidden") return NextResponse.json({ success: false, message: "Your role does not have permission to close shifts." }, { status: 403 });
  if (result.outcome === "pending_restaurant_bills") {
    const detail = result.checks.map((check) => `${check.table_name} — ${check.waiter_name} (KSh ${check.total.toFixed(2)})`).join("; ");
    return NextResponse.json({
      success: false,
      code: "PENDING_RESTAURANT_BILLS",
      message: `Cannot close shift: ${result.checks.length} restaurant bill(s) are still open. ${detail}`,
      pending_checks: result.checks,
    }, { status: 409 });
  }

  return NextResponse.json({
    success: true,
    message: result.requiresApproval
      ? `Shift closed with variance ${result.variance.toFixed(2)} — manager sign-off required.`
      : "Shift closed. No exceptions outstanding.",
    shift: {
      id: result.shift.id,
      outlet_id: result.shift.outlet_id,
      station_id: result.shift.station_id,
      cashier_id: result.shift.cashier_id,
      shift_area: result.shift.shift_area,
      shift_period: result.shift.shift_period,
      business_date: result.shift.business_date,
      opening_float: Number(result.shift.opening_float),
      cash_sales: Number(result.shift.cash_sales),
      status: result.shift.status,
      opened_at: result.shift.opened_at,
      closed_at: result.shift.closed_at ?? undefined,
      counted_cash: result.shift.counted_cash != null ? Number(result.shift.counted_cash) : undefined,
      variance: result.shift.variance != null ? Number(result.shift.variance) : undefined,
      manager_approval_required: result.requiresApproval,
    },
  });
}
