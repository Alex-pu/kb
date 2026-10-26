import { NextResponse } from "next/server";
import { databaseReady, withUserContext } from "@/lib/db/postgres";
import { assertOutletAccess, getAuthContext, hasPermission } from "@/lib/auth/require-session";
import { recordAuditEvent } from "@/lib/db/auth-repository";
import type { QueryResultRow } from "pg";

export const runtime = "nodejs";

interface TenderInput {
  type: "cash" | "mpesa" | "card";
  amount: number;
  reference?: string;
}

interface CartLineInput {
  item_id: string;
  quantity: number;
}

interface CheckoutBody {
  outlet_id?: string;
  station_id?: string;
  shift_id?: string;
  lines?: CartLineInput[];
  tenders?: TenderInput[];
  idempotency_key?: string;
}

interface ItemRow extends QueryResultRow {
  id: string;
  name: string;
  sku: string;
  price: string;
  stock_tracked: boolean;
  prep_station: "kitchen" | "bar";
}

export async function POST(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });

  let body: CheckoutBody;
  try {
    body = (await request.json()) as CheckoutBody;
  } catch {
    return NextResponse.json({ success: false, message: "Request body must be valid JSON." }, { status: 400 });
  }

  const { outlet_id, station_id, shift_id, lines, tenders, idempotency_key } = body;
  if (!outlet_id || !station_id || !shift_id || !idempotency_key || !lines?.length || !tenders?.length) {
    return NextResponse.json({ success: false, message: "outlet_id, station_id, shift_id, idempotency_key, lines and tenders are required." }, { status: 400 });
  }

  const scope = assertOutletAccess(auth.bundle, outlet_id);
  if (!scope) return NextResponse.json({ success: false, message: "You are not assigned to this outlet." }, { status: 403 });
  if (!hasPermission(auth.bundle, scope.propertyId, "pos:write")) {
    return NextResponse.json({ success: false, message: "You do not have permission to ring up sales." }, { status: 403 });
  }
  if (tenders.some((t) => t.type === "mpesa" && !t.reference?.trim())) {
    return NextResponse.json({ success: false, message: "Enter the M-Pesa transaction reference." }, { status: 400 });
  }

  try {
    const outcome = await withUserContext(auth.userId, async (run) => {
      const existingOrder = await run<{ id: string }>(
        `SELECT id FROM orders WHERE property_id = $1 AND idempotency_key = $2`,
        [scope.propertyId, idempotency_key]
      );
      if (existingOrder.rows[0]) return { outcome: "duplicate" as const };

      const shiftResult = await run<{ id: string; status: string; cash_sales: string }>(
        `SELECT id, status, cash_sales FROM shifts WHERE id = $1 AND station_id = $2`,
        [shift_id, station_id]
      );
      const shift = shiftResult.rows[0];
      if (!shift || shift.status !== "open") return { outcome: "no_shift" as const };

      const itemIds = lines.map((line) => line.item_id);
      const itemRows = await run<ItemRow>(
        `SELECT i.id, i.name, i.sku, i.price, i.stock_tracked, i.prep_station
         FROM items i
         JOIN item_outlets io ON io.item_id = i.id AND io.property_id = i.property_id
         WHERE i.id = ANY($1::uuid[]) AND io.outlet_id = $2
           AND i.is_active = TRUE AND i.item_type = 'retail'`,
        [itemIds, outlet_id]
      );
      const itemsById = new Map(itemRows.rows.map((row) => [row.id, row]));
      if (itemsById.size !== new Set(itemIds).size) return { outcome: "bad_items" as const };

      let subtotal = 0;
      const resolvedLines = lines.map((line) => {
        const item = itemsById.get(line.item_id)!;
        const unitPrice = Number(item.price);
        const lineTotal = unitPrice * line.quantity;
        subtotal += lineTotal;
        return { ...line, unitPrice, lineTotal, stockTracked: item.stock_tracked, warehouse: item.prep_station };
      });

      const tenderTotal = tenders.reduce((sum, t) => sum + t.amount, 0);
      if (Math.abs(tenderTotal - subtotal) > 0.01) return { outcome: "tender_mismatch" as const, subtotal };

      // Stock guard: for stock-tracked items, make sure there's enough on hand before committing.
      const stockDemand = new Map<string, { warehouse: "kitchen" | "bar"; quantity: number; itemName: string }>();
      for (const line of resolvedLines) {
        if (!line.stockTracked) continue;
        const current = stockDemand.get(line.item_id);
        stockDemand.set(line.item_id, {
          warehouse: line.warehouse,
          quantity: (current?.quantity ?? 0) + line.quantity,
          itemName: itemsById.get(line.item_id)!.name,
        });
      }
      for (const [itemId, demand] of stockDemand) {
        const stockResult = await run<{ quantity: string }>(
          `SELECT quantity
           FROM stock_levels
           WHERE outlet_id = $1 AND item_id = $2 AND warehouse = $3
           FOR UPDATE`,
          [outlet_id, itemId, demand.warehouse]
        );
        const available = Number(stockResult.rows[0]?.quantity ?? 0);
        if (available < demand.quantity) {
          return {
            outcome: "insufficient_stock" as const,
            itemName: demand.itemName,
            warehouse: demand.warehouse,
          };
        }
      }

      const orderResult = await run<{ id: string; created_at: string }>(
        `INSERT INTO orders (property_id, outlet_id, station_id, shift_id, cashier_id, idempotency_key, status, subtotal, total)
         VALUES ($1, $2, $3, $4, $5, $6, 'posted', $7, $7) RETURNING id, created_at`,
        [scope.propertyId, outlet_id, station_id, shift_id, auth.userId, idempotency_key, subtotal]
      );
      const orderId = orderResult.rows[0].id;

      for (const line of resolvedLines) {
        await run(
          `INSERT INTO order_lines (property_id, order_id, item_id, quantity, unit_price, line_total) VALUES ($1, $2, $3, $4, $5, $6)`,
          [scope.propertyId, orderId, line.item_id, line.quantity, line.unitPrice, line.lineTotal]
        );
        if (line.stockTracked) {
          await run(
            `UPDATE stock_levels
             SET quantity = quantity - $1, updated_at = NOW()
             WHERE outlet_id = $2 AND item_id = $3 AND warehouse = $4`,
            [line.quantity, outlet_id, line.item_id, line.warehouse]
          );
        }
      }
      for (const [itemId, demand] of stockDemand) {
        await run(
          `INSERT INTO stock_movements
             (property_id, item_id, movement_type, quantity, source_outlet_id, source_warehouse,
              reference_type, reference_id, idempotency_key, actor_user_id)
           VALUES ($1, $2, 'pos_sale', $3, $4, $5, 'pos_order', $6, $7, $8)`,
          [scope.propertyId, itemId, demand.quantity, outlet_id, demand.warehouse, orderId, `pos-sale:${orderId}:${itemId}`, auth.userId]
        );
      }

      for (const tender of tenders) {
        await run(
          `INSERT INTO payments (property_id, order_id, tender_type, amount, reference) VALUES ($1, $2, $3, $4, $5)`,
          [scope.propertyId, orderId, tender.type, tender.amount, tender.reference ?? null]
        );
      }

      const cashAmount = tenders.filter((t) => t.type === "cash").reduce((sum, t) => sum + t.amount, 0);
      await run(`UPDATE shifts SET cash_sales = cash_sales + $1 WHERE id = $2`, [cashAmount, shift_id]);

      return {
        outcome: "posted" as const,
        orderId,
        createdAt: orderResult.rows[0].created_at,
        subtotal,
        lines: resolvedLines.map((line) => ({ item: itemsById.get(line.item_id)!, quantity: line.quantity, unitPrice: line.unitPrice })),
      };
    });

    if (outcome.outcome === "duplicate") return NextResponse.json({ success: false, message: "This checkout was already submitted." }, { status: 409 });
    if (outcome.outcome === "no_shift") return NextResponse.json({ success: false, message: "Open a cashier shift before checkout." }, { status: 409 });
    if (outcome.outcome === "bad_items") return NextResponse.json({ success: false, message: "One or more items could not be found in this outlet's catalog." }, { status: 400 });
    if (outcome.outcome === "tender_mismatch") return NextResponse.json({ success: false, message: `Tender total must equal ${outcome.subtotal.toFixed(2)}.` }, { status: 400 });
    if (outcome.outcome === "insufficient_stock") {
      const warehouseName = outcome.warehouse === "bar" ? "Bar" : "Kitchen";
      return NextResponse.json({ success: false, message: `Not enough stock of ${outcome.itemName} in ${warehouseName}.` }, { status: 409 });
    }

    await recordAuditEvent({
      userId: auth.userId,
      companyId: auth.bundle.company.id,
      propertyId: scope.propertyId,
      outletId: outlet_id,
      actionType: "ORDER.CREATE",
      resourceType: "orders",
      resourceId: outcome.orderId,
    });

    return NextResponse.json({
      success: true,
      message: `Sale completed for ${outcome.subtotal.toFixed(2)}.`,
      receipt: {
        receipt_number: `KB-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${outcome.orderId.slice(-6)}`,
        order_id: outcome.orderId,
        issued_at: outcome.createdAt,
        cashier_name: auth.bundle.user.full_name,
        lines: outcome.lines.map((line) => ({
          item: { id: line.item.id, name: line.item.name, sku: line.item.sku, price: line.unitPrice },
          quantity: line.quantity,
        })),
        tenders,
        total: outcome.subtotal,
      },
    });
  } catch {
    return NextResponse.json({ success: false, message: "Checkout failed. Please try again." }, { status: 500 });
  }
}
