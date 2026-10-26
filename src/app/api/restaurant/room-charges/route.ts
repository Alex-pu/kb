import { NextResponse } from "next/server";
import type { QueryResultRow } from "pg";
import { assertOutletAccess, getAuthContext, hasPermission } from "@/lib/auth/require-session";
import { databaseReady, withUserContext } from "@/lib/db/postgres";
import { fiscalizeRestaurantBill } from "@/lib/etims/restaurant-bills";

export const runtime = "nodejs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RoomChargeRequestRow extends QueryResultRow {
  id: string;
  check_id: string;
  booking_id: string;
  folio_id: string;
  outlet_id: string;
  table_ref: string;
  table_name: string;
  guest_name: string;
  amount: string;
  requested_by: string;
  requested_by_name: string;
  status: "pending" | "approved" | "rejected";
  reason: string | null;
  created_at: Date;
}

interface ActiveRoomStayRow extends QueryResultRow {
  booking_id: string;
  guest_name: string;
  room_number: string;
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });
  const params = new URL(request.url).searchParams;
  const outletId = params.get("outlet_id") || "";
  if (outletId) {
    const scope = assertOutletAccess(auth.bundle, outletId);
    if (!scope) return NextResponse.json({ success: false, message: "You are not assigned to this outlet." }, { status: 403 });
    if (!hasPermission(auth.bundle, scope.propertyId, "restaurant:read")) {
      return NextResponse.json({ success: false, message: "You do not have permission to view active room stays." }, { status: 403 });
    }
    try {
      const stays = await withUserContext(auth.userId, (run) => run<ActiveRoomStayRow>(
        `SELECT b.id AS booking_id, b.guest_name, r.room_number
         FROM room_bookings b
         JOIN rooms r ON r.id = b.room_id AND r.property_id = b.property_id
         WHERE b.property_id = $1 AND b.status = 'checked_in'
         ORDER BY r.room_number, b.guest_name`,
        [scope.propertyId],
      ));
      return NextResponse.json({
        success: true,
        active_stays: stays.rows.map((row) => ({
          booking_id: row.booking_id,
          guest_name: row.guest_name,
          room_number: row.room_number,
        })),
      });
    } catch (error) {
      console.error("Failed to load active room stays for restaurant.", error);
      return NextResponse.json({ success: false, message: "Active room stays could not be loaded." }, { status: 500 });
    }
  }

  const propertyId = params.get("property_id") || "";
  if (!UUID_PATTERN.test(propertyId)) return NextResponse.json({ success: false, message: "A valid property_id is required." }, { status: 400 });
  if (!hasPermission(auth.bundle, propertyId, "frontdesk:read")) {
    return NextResponse.json({ success: false, message: "You do not have permission to view room-charge requests." }, { status: 403 });
  }

  try {
    const requests = await withUserContext(auth.userId, (run) => run<RoomChargeRequestRow>(
      `SELECT r.id, r.check_id, r.booking_id, r.folio_id, r.outlet_id,
              r.table_ref, r.table_name, r.guest_name, r.amount, r.requested_by,
              u.full_name AS requested_by_name, r.status, r.reason, r.created_at
       FROM restaurant_room_charge_requests r
       JOIN users u ON u.id = r.requested_by
       WHERE r.property_id = $1 AND r.status = 'pending'
       ORDER BY r.created_at, r.id`,
      [propertyId],
    ));
    return NextResponse.json({
      success: true,
      requests: requests.rows.map((row) => ({
        id: row.id,
        check_id: row.check_id,
        booking_id: row.booking_id,
        folio_id: row.folio_id,
        outlet_id: row.outlet_id,
        table_id: row.table_ref,
        table_name: row.table_name,
        guest_name: row.guest_name,
        amount: Number(row.amount),
        requested_by_user_id: row.requested_by,
        requested_by_name: row.requested_by_name,
        status: row.status,
        reason: row.reason ?? undefined,
        created_at: row.created_at.toISOString(),
      })),
    });
  } catch (error) {
    console.error("Failed to load restaurant room-charge requests.", error);
    return NextResponse.json({ success: false, message: "Room-charge requests could not be loaded." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });
  const body = await readBody(request);
  if (!body) return NextResponse.json({ success: false, message: "Request body must be a valid JSON object." }, { status: 400 });

  const action = body.action;
  const propertyId = typeof body.property_id === "string" ? body.property_id : "";
  if (!UUID_PATTERN.test(propertyId) ||
      (action !== "request" && action !== "approve" && action !== "reject" && action !== "cancel_for_payment")) {
    return NextResponse.json({ success: false, message: "A valid property and room-charge action are required." }, { status: 400 });
  }

  if (action === "request") {
    const outletId = typeof body.outlet_id === "string" ? body.outlet_id : "";
    const checkId = typeof body.check_id === "string" ? body.check_id : "";
    const bookingId = typeof body.booking_id === "string" ? body.booking_id : "";
    if (!UUID_PATTERN.test(outletId) || !UUID_PATTERN.test(checkId) || !UUID_PATTERN.test(bookingId)) {
      return NextResponse.json({ success: false, message: "Choose a restaurant bill and active room stay." }, { status: 400 });
    }
    const scope = assertOutletAccess(auth.bundle, outletId);
    if (!scope || scope.propertyId !== propertyId) return NextResponse.json({ success: false, message: "You are not assigned to this outlet." }, { status: 403 });
    if (!hasPermission(auth.bundle, propertyId, "restaurant:write")) {
      return NextResponse.json({ success: false, message: "You do not have permission to request a room charge." }, { status: 403 });
    }
    try {
      const result = await withUserContext(auth.userId, async (run) => {
        const checkResult = await run<{
          id: string; property_id: string; outlet_id: string; table_ref: string;
          table_name: string; total: string; waiter_id: string; status: string;
        }>(
          `SELECT id, property_id, outlet_id, table_ref, table_name, total, waiter_id, status
           FROM restaurant_checks
           WHERE id = $1 AND property_id = $2 AND outlet_id = $3
           FOR UPDATE`,
          [checkId, propertyId, outletId],
        );
        const check = checkResult.rows[0];
        if (!check || check.waiter_id !== auth.userId) return { outcome: "not_owner" as const };
        if (check.status !== "open") return { outcome: "not_open" as const };
        if (Number(check.total) <= 0) return { outcome: "empty_bill" as const };
        if (check.table_ref.startsWith("room-service:") &&
            check.table_ref !== `room-service:${bookingId}`) {
          return { outcome: "room_service_guest_mismatch" as const };
        }

        const bookingResult = await run<{
          id: string; folio_id: string; guest_name: string; status: string;
        }>(
          `SELECT b.id, f.id AS folio_id, b.guest_name, b.status
           FROM room_bookings b
           JOIN room_folios f ON f.booking_id = b.id AND f.property_id = b.property_id
           WHERE b.id = $1 AND b.property_id = $2
           FOR UPDATE OF b`,
          [bookingId, propertyId],
        );
        const booking = bookingResult.rows[0];
        if (!booking || booking.status !== "checked_in") return { outcome: "stay_not_active" as const };

        const inserted = await run<{ id: string }>(
          `INSERT INTO restaurant_room_charge_requests
             (property_id, outlet_id, check_id, booking_id, folio_id, table_ref, table_name,
              guest_name, amount, requested_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id`,
          [propertyId, outletId, checkId, bookingId, booking.folio_id, check.table_ref, check.table_name,
            booking.guest_name, check.total, auth.userId],
        );
        await run(
          `INSERT INTO audit_log (company_id, property_id, outlet_id, actor_user_id, action_type, resource_type, resource_id, payload_after)
           VALUES ($1, $2, $3, $4, 'RESTAURANT_CHECK.ROOM_CHARGE_REQUEST', 'restaurant_room_charge_requests', $5, $6::jsonb)`,
          [auth.bundle.company.id, propertyId, outletId, auth.userId, inserted.rows[0].id,
            JSON.stringify({ check_id: checkId, booking_id: bookingId, folio_id: booking.folio_id, amount: check.total })],
        );
        return { outcome: "created" as const, id: inserted.rows[0].id, amount: Number(check.total) };
      });
      if (result.outcome === "not_owner") return NextResponse.json({ success: false, message: "Only the waiter assigned to this bill can request a room charge." }, { status: 403 });
      if (result.outcome === "not_open") return NextResponse.json({ success: false, message: "This restaurant bill is no longer open." }, { status: 409 });
      if (result.outcome === "empty_bill") return NextResponse.json({ success: false, message: "An empty bill cannot be charged to a room." }, { status: 409 });
      if (result.outcome === "room_service_guest_mismatch") return NextResponse.json({ success: false, message: "Room-service bills can only be charged to the guest room they were created for." }, { status: 409 });
      if (result.outcome === "stay_not_active") return NextResponse.json({ success: false, message: "The selected guest must have an active checked-in stay at this property." }, { status: 409 });
      return NextResponse.json({ success: true, message: `Room charge of KSh ${result.amount.toFixed(2)} sent to reception for approval.`, request_id: result.id });
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code === "23505") return NextResponse.json({ success: false, message: "This bill already has a pending room-charge request." }, { status: 409 });
      console.error("Failed to request restaurant room charge.", error);
      return NextResponse.json({ success: false, message: "The room-charge request could not be submitted." }, { status: 500 });
    }
  }

  const requestId = typeof body.request_id === "string" ? body.request_id : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (action === "cancel_for_payment") {
    if (!UUID_PATTERN.test(requestId)) return NextResponse.json({ success: false, message: "A valid room-charge request is required." }, { status: 400 });
    if (!hasPermission(auth.bundle, propertyId, "restaurant:settle")) {
      return NextResponse.json({ success: false, message: "You do not have permission to clear restaurant bills." }, { status: 403 });
    }
    try {
      const outcome = await withUserContext(auth.userId, async (run) => {
        const requestResult = await run<{ id: string; outlet_id: string; check_id: string; status: string }>(
          `SELECT id, outlet_id, check_id, status
           FROM restaurant_room_charge_requests
           WHERE id = $1 AND property_id = $2
           FOR UPDATE`,
          [requestId, propertyId],
        );
        const charge = requestResult.rows[0];
        if (!charge) return "not_found" as const;
        if (charge.status !== "pending") return "resolved" as const;

        const checkResult = await run<{ id: string; status: string }>(
          `SELECT id, status FROM restaurant_checks
           WHERE id = $1 AND property_id = $2 AND outlet_id = $3
           FOR UPDATE`,
          [charge.check_id, propertyId, charge.outlet_id],
        );
        const check = checkResult.rows[0];
        if (!check || check.status !== "open") return "bill_not_open" as const;

        await run(
          `UPDATE restaurant_room_charge_requests
           SET status = 'rejected', reason = 'Cancelled by cashier for direct payment',
               resolved_by = $3, resolved_at = NOW()
           WHERE id = $1 AND property_id = $2 AND status = 'pending'`,
          [requestId, propertyId, auth.userId],
        );
        await run(
          `INSERT INTO audit_log (company_id, property_id, outlet_id, actor_user_id, action_type, resource_type, resource_id, payload_after)
           VALUES ($1, $2, $3, $4, 'RESTAURANT_CHECK.ROOM_CHARGE_CANCEL_FOR_PAYMENT', 'restaurant_room_charge_requests', $5, $6::jsonb)`,
          [auth.bundle.company.id, propertyId, charge.outlet_id, auth.userId, requestId,
            JSON.stringify({ check_id: charge.check_id, reason: "Cancelled by cashier for direct payment" })],
        );
        return "cancelled" as const;
      });
      if (outcome === "not_found") return NextResponse.json({ success: false, message: "Room-charge request not found." }, { status: 404 });
      if (outcome === "resolved") return NextResponse.json({ success: false, message: "This room-charge request was already resolved." }, { status: 409 });
      if (outcome === "bill_not_open") return NextResponse.json({ success: false, message: "The bill is no longer open for direct payment." }, { status: 409 });
      return NextResponse.json({ success: true, message: "Pending room charge cancelled. The cashier can now clear this bill using a normal payment." });
    } catch (error) {
      console.error("Failed to cancel pending room charge for direct payment.", error);
      return NextResponse.json({ success: false, message: "The pending room charge could not be cancelled." }, { status: 500 });
    }
  }
  if (!UUID_PATTERN.test(requestId) || (action === "reject" && (!reason || reason.length > 255))) {
    return NextResponse.json({ success: false, message: action === "reject" ? "A valid request and rejection reason are required." : "A valid request is required." }, { status: 400 });
  }
  if (!hasPermission(auth.bundle, propertyId, "frontdesk:write")) {
    return NextResponse.json({ success: false, message: "You do not have permission to approve room charges." }, { status: 403 });
  }

  try {
    const outcome = await withUserContext(auth.userId, async (run) => {
      const requestResult = await run<{
        id: string; outlet_id: string; check_id: string; booking_id: string; folio_id: string;
        table_name: string; guest_name: string; amount: string; requested_by: string; status: string;
      }>(
        `SELECT id, outlet_id, check_id, booking_id, folio_id, table_name, guest_name,
                amount, requested_by, status
         FROM restaurant_room_charge_requests
         WHERE id = $1 AND property_id = $2
         FOR UPDATE`,
        [requestId, propertyId],
      );
      const charge = requestResult.rows[0];
      if (!charge) return "not_found" as const;
      if (charge.status !== "pending") return "resolved" as const;
      if (charge.requested_by === auth.userId) return "same_user" as const;

      if (action === "reject") {
        await run(
          `UPDATE restaurant_room_charge_requests
           SET status = 'rejected', reason = $3, resolved_by = $4, resolved_at = NOW()
           WHERE id = $1 AND property_id = $2`,
          [requestId, propertyId, reason, auth.userId],
        );
        await run(
          `INSERT INTO audit_log (company_id, property_id, outlet_id, actor_user_id, action_type, resource_type, resource_id, payload_after)
           VALUES ($1, $2, $3, $4, 'RESTAURANT_CHECK.ROOM_CHARGE_REJECT', 'restaurant_room_charge_requests', $5, $6::jsonb)`,
          [auth.bundle.company.id, propertyId, charge.outlet_id, auth.userId, requestId,
            JSON.stringify({ check_id: charge.check_id, booking_id: charge.booking_id, reason })],
        );
        return "rejected" as const;
      }

      const checkResult = await run<{
        id: string; outlet_id: string; table_ref: string; table_name: string;
        lines: Array<{ item: { id: string; name: string; stock_tracked: boolean; prep_station: "kitchen" | "bar" }; quantity: number }>;
        total: string; status: string;
      }>(
        `SELECT id, outlet_id, table_ref, table_name, lines, total, status
         FROM restaurant_checks
         WHERE id = $1 AND property_id = $2
         FOR UPDATE`,
        [charge.check_id, propertyId],
      );
      const check = checkResult.rows[0];
      if (!check || check.status !== "open" || check.outlet_id !== charge.outlet_id) return "bill_not_open" as const;
      if (Number(check.total) !== Number(charge.amount)) return "bill_changed" as const;

      const bookingResult = await run<{ id: string; folio_id: string; guest_name: string; status: string }>(
        `SELECT b.id, f.id AS folio_id, b.guest_name, b.status
         FROM room_bookings b
         JOIN room_folios f ON f.booking_id = b.id AND f.property_id = b.property_id
         WHERE b.id = $1 AND b.property_id = $2
         FOR UPDATE OF b, f`,
        [charge.booking_id, propertyId],
      );
      const booking = bookingResult.rows[0];
      if (!booking || booking.status !== "checked_in" || booking.folio_id !== charge.folio_id) return "stay_not_active" as const;

      const stockDemand = new Map<string, { itemId: string; itemName: string; warehouse: "kitchen" | "bar"; quantity: number }>();
      for (const line of check.lines ?? []) {
        if (!line.item.stock_tracked) continue;
        const warehouse = line.item.prep_station === "bar" ? "bar" : "kitchen";
        const key = `${line.item.id}:${warehouse}`;
        const current = stockDemand.get(key);
        stockDemand.set(key, {
          itemId: line.item.id,
          itemName: line.item.name,
          warehouse,
          quantity: (current?.quantity ?? 0) + line.quantity,
        });
      }
      for (const demand of stockDemand.values()) {
        const stock = await run<{ quantity: string }>(
          `SELECT quantity FROM stock_levels
           WHERE outlet_id = $1 AND item_id = $2 AND warehouse = $3
           FOR UPDATE`,
          [charge.outlet_id, demand.itemId, demand.warehouse],
        );
        if (Number(stock.rows[0]?.quantity ?? 0) < demand.quantity) return "stock_low" as const;
      }
      for (const demand of stockDemand.values()) {
        await run(
          `UPDATE stock_levels SET quantity = quantity - $1, updated_at = NOW()
           WHERE outlet_id = $2 AND item_id = $3 AND warehouse = $4`,
          [demand.quantity, charge.outlet_id, demand.itemId, demand.warehouse],
        );
        await run(
          `INSERT INTO stock_movements
             (property_id, item_id, movement_type, quantity, source_outlet_id, source_warehouse,
              reference_type, reference_id, idempotency_key, actor_user_id)
           VALUES ($1, $2, 'restaurant_sale', $3, $4, $5, 'restaurant_check', $6, $7, $8)`,
          [propertyId, demand.itemId, demand.quantity, charge.outlet_id, demand.warehouse,
            check.id, `restaurant-sale:${check.id}:${demand.itemId}:${demand.warehouse}`, auth.userId],
        );
      }

      await run(
        `INSERT INTO room_folio_lines (property_id, folio_id, type, description, amount, reference)
         VALUES ($1, $2, 'service_charge', $3, $4, $5)`,
        [propertyId, charge.folio_id, `Restaurant bill ${check.table_name}`, charge.amount, `restaurant-check:${check.id}`],
      );
      await run(
        `INSERT INTO restaurant_check_payments
           (property_id, check_id, tender_type, amount, reference, idempotency_key)
         VALUES ($1, $2, 'room_charge', $3, $4, $5)`,
        [propertyId, check.id, charge.amount, charge.folio_id, `room-charge:${requestId}`],
      );
      const archivedKots = await run<{ id: string }>(
        `UPDATE restaurant_kots
         SET archived_at = NOW(), updated_at = NOW()
         WHERE check_id = $1 AND archived_at IS NULL AND status IN ('served', 'cancelled')
         RETURNING id`,
        [check.id],
      );
      await run(
        `UPDATE restaurant_checks SET status = 'settled', settled_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND property_id = $2`,
        [check.id, propertyId],
      );
      await run(
        `UPDATE restaurant_room_charge_requests
         SET status = 'approved', resolved_by = $3, resolved_at = NOW()
         WHERE id = $1 AND property_id = $2`,
        [requestId, propertyId, auth.userId],
      );
      await run(
        `INSERT INTO audit_log (company_id, property_id, outlet_id, actor_user_id, action_type, resource_type, resource_id, payload_after)
         VALUES ($1, $2, $3, $4, 'RESTAURANT_CHECK.ROOM_CHARGE', 'restaurant_checks', $5, $6::jsonb)`,
        [auth.bundle.company.id, propertyId, charge.outlet_id, auth.userId, check.id,
          JSON.stringify({ request_id: requestId, booking_id: booking.id, folio_id: charge.folio_id, amount: charge.amount, requested_by: charge.requested_by, archived_kots: archivedKots.rows.length })],
      );
      return "approved" as const;
    });

    if (outcome === "not_found") return NextResponse.json({ success: false, message: "Room-charge request not found." }, { status: 404 });
    if (outcome === "resolved") return NextResponse.json({ success: false, message: "This request has already been resolved." }, { status: 409 });
    if (outcome === "same_user") return NextResponse.json({ success: false, message: "A different receptionist must approve this request." }, { status: 409 });
    if (outcome === "bill_not_open") return NextResponse.json({ success: false, message: "The restaurant bill is no longer open." }, { status: 409 });
    if (outcome === "bill_changed") return NextResponse.json({ success: false, message: "The restaurant bill changed after this request. Refresh and submit it again." }, { status: 409 });
    if (outcome === "stay_not_active") return NextResponse.json({ success: false, message: "The guest stay is no longer active." }, { status: 409 });
    if (outcome === "stock_low") return NextResponse.json({ success: false, message: "There is not enough stock to settle this restaurant bill." }, { status: 409 });
    if (outcome === "approved") {
      const approvedBill = await withUserContext(auth.userId, (run) => run<{ check_id: string; outlet_id: string }>(
        `SELECT check_id, outlet_id FROM restaurant_room_charge_requests
         WHERE id = $1 AND property_id = $2 AND status = 'approved'`,
        [requestId, propertyId],
      ));
      let fiscalization: { status: string; message: string } = { status: "blocked", message: "The bill is paid but not yet eTIMS-signed." };
      const bill = approvedBill.rows[0];
      if (bill) {
        try {
          fiscalization = await fiscalizeRestaurantBill(auth.userId, propertyId, bill.outlet_id, bill.check_id);
        } catch (error) {
          console.error("Approved room charge could not be recorded with eTIMS.", error);
        }
      }
      return NextResponse.json({
        success: true,
        message: `Restaurant bill approved and added to the guest folio. ${fiscalization.status === "submitted" ? "eTIMS receipt received." : `Paid but not yet eTIMS-signed: ${fiscalization.message}`}`,
        fiscalization,
      });
    }
    return NextResponse.json({ success: true, message: "Room-charge request rejected." });
  } catch (error) {
    console.error(`Failed to ${action} restaurant room-charge request.`, error);
    return NextResponse.json({ success: false, message: "The room-charge request could not be resolved." }, { status: 500 });
  }
}
