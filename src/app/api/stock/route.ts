import { NextResponse } from "next/server";
import type { QueryResultRow } from "pg";
import { assertOutletAccess, getAuthContext, hasPermission } from "@/lib/auth/require-session";
import { databaseReady, withUserContext } from "@/lib/db/postgres";
import type { StockItem, StockMovement, StockRequisition } from "@/lib/types/database";

export const runtime = "nodejs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Warehouse = "kitchen" | "bar" | "supplies";

interface StockItemRow extends QueryResultRow {
  id: string;
  property_id: string;
  name: string;
  sku: string;
  unit: string;
  reorder_level: string;
  item_type: "retail" | "menu" | "supply";
  prep_station: "kitchen" | "bar";
  central_quantity: string;
  kitchen_quantity: string;
  bar_quantity: string;
  supplies_quantity: string;
  available_at_outlet: boolean;
}

interface RequisitionRow extends QueryResultRow {
  id: string;
  outlet_id: string;
  outlet_name: string;
  destination_warehouse: Warehouse;
  requester_id: string;
  requester_name: string;
  status: StockRequisition["status"];
  note: string | null;
  rejection_reason: string | null;
  created_at: string;
  lines: StockRequisition["lines"];
}

interface MovementRow extends QueryResultRow {
  id: string;
  movement_type: StockMovement["movement_type"];
  item_id: string;
  item_name: string;
  unit: string;
  quantity: string;
  source_outlet_name: string | null;
  source_warehouse: StockMovement["source_warehouse"] | null;
  destination_outlet_name: string | null;
  destination_warehouse: StockMovement["destination_warehouse"] | null;
  supplier_name: string | null;
  unit_cost: string | null;
  reason: string | null;
  actor_name: string;
  created_at: string;
}

interface MutationOutcome {
  outcome: "ok" | "duplicate" | "not_found" | "invalid_item" | "not_tracked" |
    "insufficient" | "invalid_request" | "resolved" | "not_owner" | "invalid_quantity";
  message?: string;
  id?: string;
  available?: number;
  itemName?: string;
  unit?: string;
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function validWarehouse(value: unknown): value is Warehouse {
  return value === "kitchen" || value === "bar" || value === "supplies";
}

function validQuantity(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) &&
    value > 0 && value <= 1_000_000 && Number.isInteger(value * 1000);
}

function parseRequestLines(value: unknown): Array<{ item_id: string; quantity: number }> | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) return null;
  const combined = new Map<string, number>();
  for (const row of value) {
    if (typeof row !== "object" || row === null) return null;
    const line = row as Record<string, unknown>;
    if (typeof line.item_id !== "string" || !UUID_PATTERN.test(line.item_id) || !validQuantity(line.quantity)) return null;
    const quantity = (combined.get(line.item_id) ?? 0) + line.quantity;
    if (quantity > 1_000_000 || !Number.isInteger(quantity * 1000)) return null;
    combined.set(line.item_id, quantity);
  }
  return Array.from(combined, ([item_id, quantity]) => ({ item_id, quantity }));
}

function mutationResponse(result: MutationOutcome) {
  if (result.outcome === "ok") {
    return NextResponse.json({ success: true, message: result.message, id: result.id });
  }
  if (result.outcome === "duplicate") {
    return NextResponse.json({ success: false, message: "This stock action was already recorded. Reload the stock workspace." }, { status: 409 });
  }
  if (result.outcome === "not_found") {
    return NextResponse.json({ success: false, message: "The requested stock record was not found." }, { status: 404 });
  }
  if (result.outcome === "invalid_item") {
    return NextResponse.json({ success: false, message: "The item is not active in this property." }, { status: 400 });
  }
  if (result.outcome === "not_tracked") {
    return NextResponse.json({ success: false, message: "This item does not track stock." }, { status: 409 });
  }
  if (result.outcome === "insufficient") {
    return NextResponse.json({
      success: false,
      message: `Only ${result.available ?? 0} ${result.unit ?? "unit(s)"} of ${result.itemName ?? "this item"} are available in Central Store.`,
    }, { status: 409 });
  }
  if (result.outcome === "resolved") {
    return NextResponse.json({ success: false, message: "This requisition has already been resolved." }, { status: 409 });
  }
  if (result.outcome === "not_owner") {
    return NextResponse.json({ success: false, message: "Only the requester or a stock controller can cancel this requisition." }, { status: 403 });
  }
  if (result.outcome === "invalid_quantity") {
    return NextResponse.json({ success: false, message: result.message || "The quantity exceeds the outstanding request or available stock." }, { status: 409 });
  }
  return NextResponse.json({ success: false, message: result.message || "The stock request is invalid." }, { status: 400 });
}

export async function GET(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });

  const outletId = new URL(request.url).searchParams.get("outlet_id");
  if (!outletId) return NextResponse.json({ success: false, message: "outlet_id is required." }, { status: 400 });
  const scope = assertOutletAccess(auth.bundle, outletId);
  if (!scope) return NextResponse.json({ success: false, message: "You are not assigned to this outlet." }, { status: 403 });
  if (!hasPermission(auth.bundle, scope.propertyId, "inventory:read")) {
    return NextResponse.json({ success: false, message: "You do not have permission to view stock and supply records." }, { status: 403 });
  }

  const canManage = hasPermission(auth.bundle, scope.propertyId, "inventory:manage");
  try {
    const data = await withUserContext(auth.userId, async (run) => {
      const [itemsResult, requisitionsResult, movementsResult] = await Promise.all([
        run<StockItemRow>(
          `SELECT i.id, i.property_id, i.name, i.sku, i.unit, i.reorder_level, i.item_type, i.prep_station,
                  COALESCE(cs.quantity, 0) AS central_quantity,
                  COALESCE(ks.quantity, 0) AS kitchen_quantity,
                  COALESCE(bs.quantity, 0) AS bar_quantity,
                  COALESCE(ss.quantity, 0) AS supplies_quantity,
                  EXISTS (
                    SELECT 1 FROM item_outlets io
                    WHERE io.item_id = i.id AND io.outlet_id = $2
                  ) AS available_at_outlet
           FROM items i
           LEFT JOIN central_stock_levels cs ON cs.item_id = i.id AND cs.property_id = i.property_id
           LEFT JOIN stock_levels ks ON ks.item_id = i.id AND ks.outlet_id = $2 AND ks.warehouse = 'kitchen'
           LEFT JOIN stock_levels bs ON bs.item_id = i.id AND bs.outlet_id = $2 AND bs.warehouse = 'bar'
           LEFT JOIN stock_levels ss ON ss.item_id = i.id AND ss.outlet_id = $2 AND ss.warehouse = 'supplies'
           WHERE i.property_id = $1 AND i.is_active = TRUE AND i.stock_tracked = TRUE
           ORDER BY i.name`,
          [scope.propertyId, outletId]
        ),
        run<RequisitionRow>(
          `SELECT sr.id, sr.outlet_id, o.name AS outlet_name, sr.destination_warehouse,
                  sr.requester_id, requester.full_name AS requester_name, sr.status, sr.note,
                  sr.rejection_reason, sr.created_at,
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
           LEFT JOIN stock_requisition_lines srl ON srl.requisition_id = sr.id
           LEFT JOIN items i ON i.id = srl.item_id
           WHERE sr.property_id = $1 AND ($3::boolean OR sr.outlet_id = $2)
           GROUP BY sr.id, o.name, requester.full_name
           ORDER BY sr.created_at DESC
           LIMIT 100`,
          [scope.propertyId, outletId, canManage]
        ),
        run<MovementRow>(
          `SELECT sm.id, sm.movement_type, sm.item_id, i.name AS item_name, i.unit,
                  sm.quantity, sm.source_warehouse, source.name AS source_outlet_name,
                  sm.destination_warehouse, destination.name AS destination_outlet_name,
                  sm.supplier_name, sm.unit_cost, sm.reason, actor.full_name AS actor_name,
                  sm.created_at
           FROM stock_movements sm
           JOIN items i ON i.id = sm.item_id
           JOIN users actor ON actor.id = sm.actor_user_id
           LEFT JOIN outlets source ON source.id = sm.source_outlet_id
           LEFT JOIN outlets destination ON destination.id = sm.destination_outlet_id
           WHERE sm.property_id = $1
           ORDER BY sm.created_at DESC
           LIMIT 100`,
          [scope.propertyId]
        ),
      ]);

      return {
        items: itemsResult.rows.map((row) => ({
          id: row.id,
          property_id: row.property_id,
          name: row.name,
          sku: row.sku,
          item_type: row.item_type,
          unit: row.unit,
          reorder_level: Number(row.reorder_level),
          stock_tracked: true,
          prep_station: row.prep_station,
          available_at_outlet: row.available_at_outlet,
          central_quantity: Number(row.central_quantity),
          kitchen_quantity: Number(row.kitchen_quantity),
          bar_quantity: Number(row.bar_quantity),
          supplies_quantity: Number(row.supplies_quantity),
        } satisfies StockItem)),
        requisitions: requisitionsResult.rows.map((row) => ({
          id: row.id,
          outlet_id: row.outlet_id,
          outlet_name: row.outlet_name,
          destination_warehouse: row.destination_warehouse,
          requester_id: row.requester_id,
          requester_name: row.requester_name,
          status: row.status,
          note: row.note ?? undefined,
          rejection_reason: row.rejection_reason ?? undefined,
          created_at: row.created_at,
          lines: row.lines,
        } satisfies StockRequisition)),
        movements: movementsResult.rows.map((row) => ({
          id: row.id,
          movement_type: row.movement_type,
          item_id: row.item_id,
          item_name: row.item_name,
          unit: row.unit,
          quantity: Number(row.quantity),
          source_outlet_name: row.source_outlet_name ?? undefined,
          source_warehouse: row.source_warehouse ?? undefined,
          destination_outlet_name: row.destination_outlet_name ?? undefined,
          destination_warehouse: row.destination_warehouse ?? undefined,
          supplier_name: row.supplier_name ?? undefined,
          unit_cost: row.unit_cost === null ? undefined : Number(row.unit_cost),
          reason: row.reason ?? undefined,
          actor_name: row.actor_name,
          created_at: row.created_at,
        } satisfies StockMovement)),
      };
    });
    return NextResponse.json({ success: true, ...data });
  } catch (error) {
    console.error("Failed to load stock workspace.", error);
    return NextResponse.json({ success: false, message: "Stock and supply records could not be loaded." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });
  const body = await readBody(request);
  if (!body) return NextResponse.json({ success: false, message: "Request body must be a valid JSON object." }, { status: 400 });

  const action = body.action;
  const outletId = typeof body.outlet_id === "string" ? body.outlet_id : "";
  const scope = assertOutletAccess(auth.bundle, outletId);
  if (!scope) return NextResponse.json({ success: false, message: "You are not assigned to this outlet." }, { status: 403 });

  const canManage = hasPermission(auth.bundle, scope.propertyId, "inventory:manage");
  const canRequest = hasPermission(auth.bundle, scope.propertyId, "inventory:request");
  if (action === "request" || action === "cancel") {
    if (!canRequest && !canManage) {
      return NextResponse.json({ success: false, message: "You do not have permission to request stock." }, { status: 403 });
    }
  } else if (!canManage) {
    return NextResponse.json({ success: false, message: "You do not have permission to manage stock." }, { status: 403 });
  }

  const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
  if (action !== "cancel" && action !== "reject" &&
      (!idempotencyKey || idempotencyKey.length > 160)) {
    return NextResponse.json({ success: false, message: "A valid idempotency key is required." }, { status: 400 });
  }

  if (action === "receive") {
    const itemId = typeof body.item_id === "string" ? body.item_id : "";
    const supplierName = typeof body.supplier_name === "string" ? body.supplier_name.trim() : "";
    const quantity = body.quantity;
    const unitCost = body.unit_cost;
    if (!UUID_PATTERN.test(itemId) || !supplierName || supplierName.length > 255 ||
        !validQuantity(quantity) || typeof unitCost !== "number" || !Number.isFinite(unitCost) ||
        unitCost < 0 || unitCost > 1_000_000_000 || !Number.isInteger(unitCost * 100)) {
      return NextResponse.json({ success: false, message: "Choose an item, supplier, positive quantity, and valid unit cost." }, { status: 400 });
    }

    try {
      const result = await withUserContext(auth.userId, async (run): Promise<MutationOutcome> => {
        const duplicate = await run<{ id: string }>(
          `SELECT id FROM stock_movements WHERE property_id = $1 AND idempotency_key = $2`,
          [scope.propertyId, idempotencyKey]
        );
        if (duplicate.rows[0]) return { outcome: "duplicate" };
        const itemResult = await run<{ id: string; name: string; stock_tracked: boolean }>(
          `SELECT id, name, stock_tracked FROM items
           WHERE id = $1 AND property_id = $2 AND is_active = TRUE`,
          [itemId, scope.propertyId]
        );
        const item = itemResult.rows[0];
        if (!item) return { outcome: "invalid_item" };
        if (!item.stock_tracked) return { outcome: "not_tracked" };

        await run(
          `INSERT INTO central_stock_levels (property_id, item_id, quantity)
           VALUES ($1, $2, 0) ON CONFLICT (property_id, item_id) DO NOTHING`,
          [scope.propertyId, itemId]
        );
        const stockResult = await run<{ quantity: string }>(
          `SELECT quantity FROM central_stock_levels
           WHERE property_id = $1 AND item_id = $2 FOR UPDATE`,
          [scope.propertyId, itemId]
        );
        await run(
          `UPDATE central_stock_levels SET quantity = quantity + $1, updated_at = NOW()
           WHERE property_id = $2 AND item_id = $3`,
          [quantity, scope.propertyId, itemId]
        );
        await run(
          `INSERT INTO stock_movements
             (property_id, item_id, movement_type, quantity, destination_warehouse,
              unit_cost, supplier_name, idempotency_key, actor_user_id)
           VALUES ($1, $2, 'purchase_receipt', $3, 'central', $4, $5, $6, $7)`,
          [scope.propertyId, itemId, quantity, unitCost, supplierName, idempotencyKey, auth.userId]
        );
        return {
          outcome: "ok",
          message: `Received ${quantity} unit(s) of ${item.name} into Central Store. Central balance is now ${Number(stockResult.rows[0].quantity) + quantity}.`,
        };
      });
      return mutationResponse(result);
    } catch (error) {
      console.error("Failed to receive stock into Central Store.", error);
      return NextResponse.json({ success: false, message: "The purchase receipt was not recorded." }, { status: 500 });
    }
  }

  if (action === "transfer" || action === "wastage") {
    const itemId = typeof body.item_id === "string" ? body.item_id : "";
    const quantity = body.quantity;
    const warehouse = body.warehouse;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!UUID_PATTERN.test(itemId) || !validQuantity(quantity) ||
        (action === "transfer" && !validWarehouse(warehouse)) ||
        (action === "wastage" && (!validWarehouse(warehouse) || !reason || reason.length > 500))) {
      return NextResponse.json({ success: false, message: "The item, warehouse, quantity, and required details are invalid." }, { status: 400 });
    }

    try {
      const result = await withUserContext(auth.userId, async (run): Promise<MutationOutcome> => {
        const duplicate = await run<{ id: string }>(
          `SELECT id FROM stock_movements WHERE property_id = $1 AND idempotency_key = $2`,
          [scope.propertyId, idempotencyKey]
        );
        if (duplicate.rows[0]) return { outcome: "duplicate" };
        const itemResult = await run<{ id: string; name: string; unit: string; stock_tracked: boolean; item_type: string }>(
          `SELECT id, name, unit, stock_tracked, item_type FROM items
           WHERE id = $1 AND property_id = $2 AND is_active = TRUE`,
          [itemId, scope.propertyId]
        );
        const item = itemResult.rows[0];
        if (!item) return { outcome: "invalid_item" };
        if (!item.stock_tracked) return { outcome: "not_tracked" };
        if ((item.item_type === "supply") !== (warehouse === "supplies")) {
          return {
            outcome: "invalid_request",
            message: item.item_type === "supply"
              ? "Supply items must be moved to or adjusted in the Supplies balance."
              : "Only non-sale supply items can use the Supplies balance.",
          };
        }

        if (action === "transfer") {
          await run(
            `INSERT INTO central_stock_levels (property_id, item_id, quantity)
             VALUES ($1, $2, 0) ON CONFLICT (property_id, item_id) DO NOTHING`,
            [scope.propertyId, itemId]
          );
          const centralResult = await run<{ quantity: string }>(
            `SELECT quantity FROM central_stock_levels
             WHERE property_id = $1 AND item_id = $2 FOR UPDATE`,
            [scope.propertyId, itemId]
          );
          const available = Number(centralResult.rows[0]?.quantity ?? 0);
          if (available < quantity) {
            return { outcome: "insufficient", available, itemName: item.name, unit: item.unit };
          }
          await run(
            `INSERT INTO item_outlets (property_id, outlet_id, item_id)
             VALUES ($1, $2, $3) ON CONFLICT (outlet_id, item_id) DO NOTHING`,
            [scope.propertyId, outletId, itemId]
          );
          await run(
            `INSERT INTO stock_levels (property_id, outlet_id, item_id, warehouse, quantity)
             VALUES ($1, $2, $3, $4, 0)
             ON CONFLICT (outlet_id, item_id, warehouse) DO NOTHING`,
            [scope.propertyId, outletId, itemId, warehouse]
          );
          await run(
            `UPDATE central_stock_levels SET quantity = quantity - $1, updated_at = NOW()
             WHERE property_id = $2 AND item_id = $3`,
            [quantity, scope.propertyId, itemId]
          );
          await run(
            `UPDATE stock_levels SET quantity = quantity + $1, updated_at = NOW()
             WHERE outlet_id = $2 AND item_id = $3 AND warehouse = $4`,
            [quantity, outletId, itemId, warehouse]
          );
          await run(
            `INSERT INTO stock_movements
               (property_id, item_id, movement_type, quantity, source_warehouse,
                destination_outlet_id, destination_warehouse, idempotency_key, actor_user_id)
             VALUES ($1, $2, 'stock_transfer', $3, 'central', $4, $5, $6, $7)`,
            [scope.propertyId, itemId, quantity, outletId, warehouse, idempotencyKey, auth.userId]
          );
          return { outcome: "ok", message: `Transferred ${quantity} ${item.unit} of ${item.name} to ${warehouse}.` };
        }

        const levelResult = await run<{ quantity: string }>(
          `SELECT quantity FROM stock_levels
           WHERE outlet_id = $1 AND item_id = $2 AND warehouse = $3 FOR UPDATE`,
          [outletId, itemId, warehouse]
        );
        const available = Number(levelResult.rows[0]?.quantity ?? 0);
        if (available < quantity) {
          return {
            outcome: "invalid_quantity",
            message: `Only ${available} ${item.unit} of ${item.name} are available in ${warehouse}.`,
          };
        }
        await run(
          `UPDATE stock_levels SET quantity = quantity - $1, updated_at = NOW()
           WHERE outlet_id = $2 AND item_id = $3 AND warehouse = $4`,
          [quantity, outletId, itemId, warehouse]
        );
        await run(
          `INSERT INTO stock_movements
             (property_id, item_id, movement_type, quantity, source_outlet_id, source_warehouse,
              reason, idempotency_key, actor_user_id)
           VALUES ($1, $2, 'wastage', $3, $4, $5, $6, $7, $8)`,
          [scope.propertyId, itemId, quantity, outletId, warehouse, reason, idempotencyKey, auth.userId]
        );
        return { outcome: "ok", message: `Recorded ${quantity} ${item.unit} wastage for ${item.name} in ${warehouse}.` };
      });
      return mutationResponse(result);
    } catch (error) {
      console.error(`Failed to ${action === "transfer" ? "transfer" : "record wastage for"} stock.`, error);
      return NextResponse.json({ success: false, message: "The stock movement was not recorded." }, { status: 500 });
    }
  }

  if (action === "request") {
    const warehouse = body.warehouse;
    const note = typeof body.note === "string" ? body.note.trim() : "";
    const lines = parseRequestLines(body.lines);
    if (!validWarehouse(warehouse) || !lines || note.length > 500) {
      return NextResponse.json({ success: false, message: "Choose a destination warehouse and at least one valid item quantity." }, { status: 400 });
    }

    try {
      const result = await withUserContext(auth.userId, async (run): Promise<MutationOutcome> => {
        const duplicate = await run<{ id: string }>(
          `SELECT id FROM stock_requisitions WHERE property_id = $1 AND idempotency_key = $2`,
          [scope.propertyId, idempotencyKey]
        );
        if (duplicate.rows[0]) return { outcome: "duplicate" };
        const itemIds = lines.map((line) => line.item_id);
        const itemResult = await run<{ id: string; item_type: string }>(
          `SELECT id, item_type FROM items
           WHERE id = ANY($1::uuid[]) AND property_id = $2 AND is_active = TRUE AND stock_tracked = TRUE`,
          [itemIds, scope.propertyId]
        );
        if (itemResult.rows.length !== itemIds.length) return { outcome: "invalid_item" };
        if (itemResult.rows.some((item) => (item.item_type === "supply") !== (warehouse === "supplies"))) {
          return {
            outcome: "invalid_request",
            message: warehouse === "supplies"
              ? "Only non-sale supply items can be requested for the Supplies balance."
              : "Non-sale supply items must be requested for the Supplies balance.",
          };
        }
        const requisitionResult = await run<{ id: string }>(
          `INSERT INTO stock_requisitions
             (property_id, outlet_id, destination_warehouse, requester_id, note, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [scope.propertyId, outletId, warehouse, auth.userId, note || null, idempotencyKey]
        );
        for (const line of lines) {
          await run(
            `INSERT INTO stock_requisition_lines (property_id, requisition_id, item_id, quantity_requested)
             VALUES ($1, $2, $3, $4)`,
            [scope.propertyId, requisitionResult.rows[0].id, line.item_id, line.quantity]
          );
        }
        return {
          outcome: "ok",
          id: requisitionResult.rows[0].id,
          message: "Stock request submitted to the Central Store.",
        };
      });
      return mutationResponse(result);
    } catch (error) {
      console.error("Failed to submit stock requisition.", error);
      return NextResponse.json({ success: false, message: "The stock request was not saved." }, { status: 500 });
    }
  }

  if (action === "fulfill") {
    const requisitionId = typeof body.requisition_id === "string" ? body.requisition_id : "";
    const itemId = typeof body.item_id === "string" ? body.item_id : "";
    const quantity = body.quantity;
    if (!UUID_PATTERN.test(requisitionId) || !UUID_PATTERN.test(itemId) || !validQuantity(quantity)) {
      return NextResponse.json({ success: false, message: "A valid requisition, item, and fulfillment quantity are required." }, { status: 400 });
    }

    try {
      const result = await withUserContext(auth.userId, async (run): Promise<MutationOutcome> => {
        const duplicate = await run<{ id: string }>(
          `SELECT id FROM stock_movements WHERE property_id = $1 AND idempotency_key = $2`,
          [scope.propertyId, idempotencyKey]
        );
        if (duplicate.rows[0]) return { outcome: "duplicate" };
        const requisitionResult = await run<{
          id: string;
          outlet_id: string;
          destination_warehouse: Warehouse;
          status: StockRequisition["status"];
        }>(
          `SELECT id, outlet_id, destination_warehouse, status
           FROM stock_requisitions
           WHERE id = $1 AND property_id = $2
           FOR UPDATE`,
          [requisitionId, scope.propertyId]
        );
        const requisition = requisitionResult.rows[0];
        if (!requisition || requisition.outlet_id !== outletId) return { outcome: "not_found" };
        if (requisition.status !== "pending" && requisition.status !== "partially_fulfilled") return { outcome: "resolved" };
        const lineResult = await run<{
          quantity_requested: string;
          quantity_fulfilled: string;
          name: string;
          unit: string;
          item_type: string;
        }>(
          `SELECT srl.quantity_requested, srl.quantity_fulfilled, i.name, i.unit, i.item_type
           FROM stock_requisition_lines srl
           JOIN items i ON i.id = srl.item_id
           WHERE srl.requisition_id = $1 AND srl.item_id = $2
           FOR UPDATE OF srl`,
          [requisitionId, itemId]
        );
        const line = lineResult.rows[0];
        if (!line) return { outcome: "invalid_item" };
        if ((line.item_type === "supply") !== (requisition.destination_warehouse === "supplies")) {
          return { outcome: "invalid_request", message: "This item does not match the request's destination balance." };
        }
        const remaining = Number(line.quantity_requested) - Number(line.quantity_fulfilled);
        if (quantity > remaining) {
          return { outcome: "invalid_quantity", message: `Only ${remaining} ${line.unit} remain on this request.` };
        }
        const centralResult = await run<{ quantity: string }>(
          `SELECT quantity FROM central_stock_levels
           WHERE property_id = $1 AND item_id = $2 FOR UPDATE`,
          [scope.propertyId, itemId]
        );
        const available = Number(centralResult.rows[0]?.quantity ?? 0);
        if (available < quantity) {
          return { outcome: "insufficient", available, itemName: line.name, unit: line.unit };
        }

        await run(
          `INSERT INTO item_outlets (property_id, outlet_id, item_id)
           VALUES ($1, $2, $3) ON CONFLICT (outlet_id, item_id) DO NOTHING`,
          [scope.propertyId, outletId, itemId]
        );
        await run(
          `INSERT INTO stock_levels (property_id, outlet_id, item_id, warehouse, quantity)
           VALUES ($1, $2, $3, $4, 0)
           ON CONFLICT (outlet_id, item_id, warehouse) DO NOTHING`,
          [scope.propertyId, outletId, itemId, requisition.destination_warehouse]
        );
        await run(
          `UPDATE central_stock_levels SET quantity = quantity - $1, updated_at = NOW()
           WHERE property_id = $2 AND item_id = $3`,
          [quantity, scope.propertyId, itemId]
        );
        await run(
          `UPDATE stock_levels SET quantity = quantity + $1, updated_at = NOW()
           WHERE outlet_id = $2 AND item_id = $3 AND warehouse = $4`,
          [quantity, outletId, itemId, requisition.destination_warehouse]
        );
        await run(
          `INSERT INTO stock_movements
             (property_id, item_id, movement_type, quantity, source_warehouse,
              destination_outlet_id, destination_warehouse, reference_type, reference_id,
              requisition_id, idempotency_key, actor_user_id)
           VALUES ($1, $2, 'stock_transfer', $3, 'central', $4, $5, 'stock_requisition', $6, $6, $7, $8)`,
          [scope.propertyId, itemId, quantity, outletId, requisition.destination_warehouse, requisitionId, idempotencyKey, auth.userId]
        );
        await run(
          `UPDATE stock_requisition_lines
           SET quantity_fulfilled = quantity_fulfilled + $1
           WHERE requisition_id = $2 AND item_id = $3`,
          [quantity, requisitionId, itemId]
        );
        const statusResult = await run<{ all_fulfilled: boolean; any_fulfilled: boolean }>(
          `SELECT BOOL_AND(quantity_fulfilled >= quantity_requested) AS all_fulfilled,
                  BOOL_OR(quantity_fulfilled > 0) AS any_fulfilled
           FROM stock_requisition_lines
           WHERE requisition_id = $1`,
          [requisitionId]
        );
        const nextStatus = statusResult.rows[0].all_fulfilled
          ? "fulfilled"
          : statusResult.rows[0].any_fulfilled
            ? "partially_fulfilled"
            : "pending";
        await run(
          `UPDATE stock_requisitions
           SET status = $1::varchar(24),
               resolved_by = CASE WHEN $1::varchar(24) = 'fulfilled' THEN $2 ELSE resolved_by END,
               resolved_at = CASE WHEN $1::varchar(24) = 'fulfilled' THEN NOW() ELSE NULL END,
               updated_at = NOW()
           WHERE id = $3`,
          [nextStatus, auth.userId, requisitionId]
        );
        return {
          outcome: "ok",
          message: `Issued ${quantity} ${line.unit} of ${line.name} to ${requisition.destination_warehouse}.`,
        };
      });
      return mutationResponse(result);
    } catch (error) {
      console.error("Failed to fulfill stock requisition.", error);
      return NextResponse.json({ success: false, message: "The stock request was not fulfilled." }, { status: 500 });
    }
  }

  if (action === "reject" || action === "cancel") {
    const requisitionId = typeof body.requisition_id === "string" ? body.requisition_id : "";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!UUID_PATTERN.test(requisitionId) || (action === "reject" && (!reason || reason.length > 500))) {
      return NextResponse.json({ success: false, message: "A valid requisition and rejection reason are required." }, { status: 400 });
    }
    if (action === "reject" && !canManage) {
      return NextResponse.json({ success: false, message: "Only a stock controller can reject a stock request." }, { status: 403 });
    }

    try {
      const result = await withUserContext(auth.userId, async (run): Promise<MutationOutcome> => {
        const requisitionResult = await run<{
          id: string;
          requester_id: string;
          status: StockRequisition["status"];
        }>(
          `SELECT id, requester_id, status FROM stock_requisitions
           WHERE id = $1 AND property_id = $2 AND outlet_id = $3
           FOR UPDATE`,
          [requisitionId, scope.propertyId, outletId]
        );
        const requisition = requisitionResult.rows[0];
        if (!requisition) return { outcome: "not_found" };
        if (action === "cancel" && requisition.requester_id !== auth.userId && !canManage) {
          return { outcome: "not_owner" };
        }
        if (requisition.status !== "pending" && requisition.status !== "partially_fulfilled") {
          return { outcome: "resolved" };
        }
        const status = action === "reject" ? "rejected" : "cancelled";
        await run(
          `UPDATE stock_requisitions
           SET status = $1, rejection_reason = $2, resolved_by = $3, resolved_at = NOW(), updated_at = NOW()
           WHERE id = $4`,
          [status, action === "reject" ? reason : null, auth.userId, requisitionId]
        );
        await run(
          `INSERT INTO audit_log
             (company_id, property_id, outlet_id, actor_user_id, action_type, resource_type, resource_id, payload_after)
           VALUES ($1, $2, $3, $4, $5, 'stock_requisitions', $6, $7::jsonb)`,
          [
            auth.bundle.company.id,
            scope.propertyId,
            outletId,
            auth.userId,
            action === "reject" ? "STOCK.REQUEST_REJECT" : "STOCK.REQUEST_CANCEL",
            requisitionId,
            JSON.stringify({ status, reason: action === "reject" ? reason : undefined }),
          ]
        );
        return {
          outcome: "ok",
          message: action === "reject" ? "Stock request rejected." : "Stock request cancelled.",
        };
      });
      return mutationResponse(result);
    } catch (error) {
      console.error(`Failed to ${action} stock requisition.`, error);
      return NextResponse.json({ success: false, message: "The stock request status was not changed." }, { status: 500 });
    }
  }

  return NextResponse.json({ success: false, message: "Unsupported stock action." }, { status: 400 });
}
