import { NextResponse } from "next/server";
import type { QueryResult, QueryResultRow } from "pg";
import { assertOutletAccess, getAuthContext, hasPermission } from "@/lib/auth/require-session";
import { databaseReady, withUserContext } from "@/lib/db/postgres";

export const runtime = "nodejs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_QUANTITY = 1_000_000;
const MAX_UNIT_COST = 1_000_000_000;
const MAX_PURCHASE_TOTAL_CENTS = 999_999_999_999;

interface PurchaseLineInput {
  item_id: string;
  quantity: number;
  unit_cost: number;
}

interface PurchaseItemRow extends QueryResultRow {
  id: string;
  name: string;
  sku: string;
  unit: string;
  item_type: "retail" | "menu" | "supply";
}

interface PurchaseRow extends QueryResultRow {
  id: string;
  supplier_name: string;
  purchase_date: string;
  status: "draft" | "ordered" | "received";
  total: string;
  created_at: string;
  ordered_at: string | null;
  received_at: string | null;
  created_by_name: string;
  ordered_by_name: string | null;
  received_by_name: string | null;
  lines: Array<{
    id: string;
    item_id: string;
    item_name: string;
    unit: string;
    quantity: string;
    unit_cost: string;
    line_total: string;
  }>;
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validQuantity(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) &&
    value > 0 && value <= MAX_QUANTITY && Number.isInteger(value * 1000);
}

function validMoney(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) &&
    value >= 0 && value <= MAX_UNIT_COST &&
    Math.abs(Math.round(value * 100) - value * 100) < 0.0001;
}

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maxLength;
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

function parseLines(value: unknown): PurchaseLineInput[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) return null;
  const itemIds = new Set<string>();
  const lines: PurchaseLineInput[] = [];
  let totalCents = 0;
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;
    const line = candidate as Record<string, unknown>;
    if (typeof line.item_id !== "string" || !UUID_PATTERN.test(line.item_id) ||
        itemIds.has(line.item_id) || !validQuantity(line.quantity) || !validMoney(line.unit_cost)) return null;
    const lineTotalCents = Math.round(line.quantity * line.unit_cost * 100);
    if (!Number.isSafeInteger(lineTotalCents) || lineTotalCents < 0 ||
        lineTotalCents > MAX_PURCHASE_TOTAL_CENTS ||
        totalCents + lineTotalCents > MAX_PURCHASE_TOTAL_CENTS) return null;
    totalCents += lineTotalCents;
    itemIds.add(line.item_id);
    lines.push({ item_id: line.item_id, quantity: line.quantity, unit_cost: line.unit_cost });
  }
  return lines;
}

function errorResponse(message: string, status = 400) {
  return NextResponse.json({ success: false, message }, { status });
}

export async function GET(request: Request) {
  if (!databaseReady()) return errorResponse("DATABASE_URL is not configured.", 503);
  const auth = await getAuthContext();
  if (!auth) return errorResponse("Not signed in.", 401);

  const params = new URL(request.url).searchParams;
  const outletId = params.get("outlet_id") ?? "";
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const status = params.get("status") ?? "all";
  const scope = assertOutletAccess(auth.bundle, outletId);
  if (!scope) return errorResponse("You are not assigned to this outlet.", 403);
  if (!hasPermission(auth.bundle, scope.propertyId, "inventory:read")) {
    return errorResponse("You do not have permission to view purchases.", 403);
  }
  if (!isDate(from) || !isDate(to) || from > to) {
    return errorResponse("Choose a valid purchase date range.", 400);
  }
  const rangeLength = (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000 + 1;
  if (rangeLength > 3_660) return errorResponse("Purchase report date ranges cannot exceed ten years.", 400);
  if (!["all", "draft", "ordered", "received"].includes(status)) {
    return errorResponse("Choose a valid purchase status filter.", 400);
  }

  try {
    const data = await withUserContext(auth.userId, async (run) => {
      const [items, purchases] = await Promise.all([
        run<PurchaseItemRow>(
          `SELECT id, name, sku, unit, item_type
           FROM items
           WHERE property_id = $1 AND is_active = TRUE AND stock_tracked = TRUE
           ORDER BY name`,
          [scope.propertyId]
        ),
        run<PurchaseRow>(
          `SELECT p.id, p.supplier_name, to_char(p.purchase_date, 'YYYY-MM-DD') AS purchase_date,
                  p.status, p.total::text, p.created_at, p.ordered_at, p.received_at,
                  creator.full_name AS created_by_name,
                  orderer.full_name AS ordered_by_name,
                  receiver.full_name AS received_by_name,
                  COALESCE(
                    jsonb_agg(jsonb_build_object(
                      'id', pl.id,
                      'item_id', pl.item_id,
                      'item_name', pl.item_name,
                      'unit', pl.unit,
                      'quantity', pl.quantity::text,
                      'unit_cost', pl.unit_cost::text,
                      'line_total', pl.line_total::text
                    ) ORDER BY pl.item_name) FILTER (WHERE pl.id IS NOT NULL),
                    '[]'::jsonb
                  ) AS lines
           FROM purchases p
           JOIN users creator ON creator.id = p.created_by
           LEFT JOIN users orderer ON orderer.id = p.ordered_by
           LEFT JOIN users receiver ON receiver.id = p.received_by
           LEFT JOIN purchase_lines pl ON pl.purchase_id = p.id AND pl.property_id = p.property_id
           WHERE p.property_id = $1
             AND p.purchase_date BETWEEN $2::date AND $3::date
             AND ($4::text = 'all' OR p.status = $4)
           GROUP BY p.id, creator.full_name, orderer.full_name, receiver.full_name
           ORDER BY p.purchase_date DESC, p.created_at DESC
           LIMIT 1000`,
          [scope.propertyId, from, to, status]
        ),
      ]);
      return { items: items.rows, purchases: purchases.rows };
    });

    return NextResponse.json({
      success: true,
      items: data.items,
      purchases: data.purchases.map((purchase) => ({
        ...purchase,
        total: Number(purchase.total),
        lines: purchase.lines.map((line) => ({
          ...line,
          quantity: Number(line.quantity),
          unit_cost: Number(line.unit_cost),
          line_total: Number(line.line_total),
        })),
      })),
    });
  } catch (error) {
    console.error("Failed to load purchases.", error);
    return errorResponse("Purchases could not be loaded.", 500);
  }
}

export async function POST(request: Request) {
  if (!databaseReady()) return errorResponse("DATABASE_URL is not configured.", 503);
  const auth = await getAuthContext();
  if (!auth) return errorResponse("Not signed in.", 401);
  const body = await readBody(request);
  if (!body) return errorResponse("Request body must be a valid JSON object.");

  const outletId = typeof body.outlet_id === "string" ? body.outlet_id : "";
  const scope = assertOutletAccess(auth.bundle, outletId);
  if (!scope) return errorResponse("You are not assigned to this outlet.", 403);
  if (!hasPermission(auth.bundle, scope.propertyId, "inventory:manage")) {
    return errorResponse("You do not have permission to manage purchases.", 403);
  }

  if (body.action === "create_item") {
    if (!validText(body.name, 255) ||
        (body.unit !== undefined && (!validText(body.unit, 40)))) {
      return errorResponse("Enter a product name and a unit of up to 40 characters.");
    }
    const name = body.name.trim();
    const unit = typeof body.unit === "string" ? body.unit.trim() : "each";
    try {
      const item = await withUserContext(auth.userId, async (run) => {
        let sku = "";
        while (!sku) {
          const counter = await run<{ allocated_value: string }>(
            `INSERT INTO catalog_sku_counters (property_id, next_value)
             VALUES ($1, 2)
             ON CONFLICT (property_id)
             DO UPDATE SET next_value = catalog_sku_counters.next_value + 1
             RETURNING (next_value - 1)::text AS allocated_value`,
            [scope.propertyId]
          );
          const candidate = `SKU-${counter.rows[0].allocated_value.padStart(6, "0")}`;
          const existing = await run<{ id: string }>(
            "SELECT id FROM items WHERE property_id = $1 AND sku = $2",
            [scope.propertyId, candidate]
          );
          if (!existing.rows[0]) sku = candidate;
        }

        const inserted = await run<{ id: string }>(
          `INSERT INTO items
             (property_id, outlet_id, name, sku, item_type, price, stock_tracked,
              reorder_level, prep_station, unit)
           VALUES ($1, $2, $3, $4, 'supply', 0, TRUE, 0, 'kitchen', $5)
           RETURNING id`,
          [scope.propertyId, outletId, name, sku, unit]
        );
        const itemId = inserted.rows[0].id;
        await run(
          "INSERT INTO item_outlets (property_id, outlet_id, item_id) VALUES ($1, $2, $3)",
          [scope.propertyId, outletId, itemId]
        );
        await run(
          "INSERT INTO central_stock_levels (property_id, item_id, quantity) VALUES ($1, $2, 0)",
          [scope.propertyId, itemId]
        );
        await run(
          `INSERT INTO stock_levels (property_id, outlet_id, item_id, warehouse, quantity)
           VALUES ($1, $2, $3, 'supplies', 0)`,
          [scope.propertyId, outletId, itemId]
        );
        await run(
          `INSERT INTO audit_log
             (company_id, property_id, outlet_id, actor_user_id, action_type, resource_type, resource_id, payload_after)
           VALUES ($1, $2, $3, $4, 'CATALOG.SUPPLY.CREATE', 'items', $5, $6::jsonb)`,
          [auth.bundle.company.id, scope.propertyId, outletId, auth.userId, itemId, JSON.stringify({ name, unit, sku })]
        );
        return { id: itemId, name, sku, unit, item_type: "supply" as const };
      });
      return NextResponse.json({ success: true, item, message: "Stock supply added to the catalog." }, { status: 201 });
    } catch (error) {
      console.error("Failed to create a stock supply from purchases.", error);
      return errorResponse("The stock supply could not be added.", 500);
    }
  }

  if (body.action !== "save_draft") return errorResponse("Choose a valid purchase action.");
  const supplierName = typeof body.supplier_name === "string" ? body.supplier_name.trim() : "";
  const purchaseDate = body.purchase_date;
  const lines = parseLines(body.lines);
  const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
  if (!validText(supplierName, 255) || !isDate(purchaseDate) || !lines ||
      idempotencyKey.length === 0 || idempotencyKey.length > 160) {
    return errorResponse("Enter a supplier, purchase date, at least one valid product line, and an idempotency key.");
  }

  try {
    const result = await withUserContext(auth.userId, async (run) => {
      const duplicate = await run<{ id: string }>(
        "SELECT id FROM purchases WHERE property_id = $1 AND idempotency_key = $2",
        [scope.propertyId, idempotencyKey]
      );
      if (duplicate.rows[0]) return { id: duplicate.rows[0].id, duplicate: true };

      const itemIds = lines.map((line) => line.item_id);
      const itemResult = await run<PurchaseItemRow>(
        `SELECT id, name, sku, unit, item_type
         FROM items
         WHERE property_id = $1 AND id = ANY($2::uuid[])
           AND is_active = TRUE AND stock_tracked = TRUE
         ORDER BY id`,
        [scope.propertyId, itemIds]
      );
      if (itemResult.rows.length !== lines.length) return null;
      const itemsById = new Map(itemResult.rows.map((item) => [item.id, item]));

      const inserted = await run<{ id: string }>(
        `INSERT INTO purchases
           (property_id, supplier_name, purchase_date, status, idempotency_key, created_by)
         VALUES ($1, $2, $3::date, 'draft', $4, $5)
         RETURNING id`,
        [scope.propertyId, supplierName, purchaseDate, idempotencyKey, auth.userId]
      );
      const purchaseId = inserted.rows[0].id;
      const total = await replaceLines(run, scope.propertyId, purchaseId, lines, itemsById);
      await run(
        "UPDATE purchases SET total = $1, updated_at = NOW() WHERE id = $2 AND property_id = $3",
        [total, purchaseId, scope.propertyId]
      );
      await run(
        `INSERT INTO audit_log
           (company_id, property_id, outlet_id, actor_user_id, action_type, resource_type, resource_id, payload_after)
         VALUES ($1, $2, $3, $4, 'PURCHASE.DRAFT.CREATE', 'purchases', $5, $6::jsonb)`,
        [auth.bundle.company.id, scope.propertyId, outletId, auth.userId, purchaseId,
          JSON.stringify({ supplier_name: supplierName, purchase_date: purchaseDate, total, line_count: lines.length })]
      );
      return { id: purchaseId, duplicate: false };
    });
    if (!result) return errorResponse("One or more selected products are inactive or do not track stock.", 400);
    return NextResponse.json({
      success: true,
      id: result.id,
      message: result.duplicate ? "This draft was already saved." : "Purchase draft saved.",
    }, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    console.error("Failed to save a purchase draft.", error);
    return errorResponse("The purchase draft could not be saved.", 500);
  }
}

async function replaceLines(
  run: <R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) => Promise<QueryResult<R>>,
  propertyId: string,
  purchaseId: string,
  lines: PurchaseLineInput[],
  itemsById: Map<string, PurchaseItemRow>
) {
  let totalCents = 0;
  for (const line of lines) {
    const item = itemsById.get(line.item_id);
    if (!item) throw new Error("A purchase item was missing after validation.");
    const inserted = await run<{ line_total: string }>(
      `INSERT INTO purchase_lines
         (property_id, purchase_id, item_id, item_name, unit, quantity, unit_cost, line_total)
       VALUES ($1, $2, $3, $4, $5, $6, $7, ROUND($6::numeric * $7::numeric, 2))
       RETURNING line_total::text`,
      [propertyId, purchaseId, line.item_id, item.name, item.unit, line.quantity, line.unit_cost]
    );
    totalCents += Math.round(Number(inserted.rows[0].line_total) * 100);
  }
  return (totalCents / 100).toFixed(2);
}

export async function PUT(request: Request) {
  if (!databaseReady()) return errorResponse("DATABASE_URL is not configured.", 503);
  const auth = await getAuthContext();
  if (!auth) return errorResponse("Not signed in.", 401);
  const body = await readBody(request);
  if (!body) return errorResponse("Request body must be a valid JSON object.");

  const outletId = typeof body.outlet_id === "string" ? body.outlet_id : "";
  const scope = assertOutletAccess(auth.bundle, outletId);
  if (!scope) return errorResponse("You are not assigned to this outlet.", 403);
  if (!hasPermission(auth.bundle, scope.propertyId, "inventory:manage")) {
    return errorResponse("You do not have permission to manage purchases.", 403);
  }
  const purchaseId = typeof body.purchase_id === "string" ? body.purchase_id : "";
  const supplierName = typeof body.supplier_name === "string" ? body.supplier_name.trim() : "";
  const purchaseDate = body.purchase_date;
  const lines = parseLines(body.lines);
  if (!UUID_PATTERN.test(purchaseId) || !validText(supplierName, 255) ||
      !isDate(purchaseDate) || !lines) {
    return errorResponse("Enter a valid draft, supplier, purchase date, and at least one valid product line.");
  }

  try {
    const result = await withUserContext(auth.userId, async (run) => {
      const purchase = await run<{ id: string; status: string; supplier_name: string; total: string }>(
        `SELECT id, status, supplier_name, total::text
         FROM purchases WHERE id = $1 AND property_id = $2 FOR UPDATE`,
        [purchaseId, scope.propertyId]
      );
      const current = purchase.rows[0];
      if (!current) return { outcome: "not_found" as const };
      if (current.status !== "draft") return { outcome: "locked" as const };

      const itemIds = lines.map((line) => line.item_id);
      const itemResult = await run<PurchaseItemRow>(
        `SELECT id, name, sku, unit, item_type
         FROM items
         WHERE property_id = $1 AND id = ANY($2::uuid[])
           AND is_active = TRUE AND stock_tracked = TRUE
         ORDER BY id`,
        [scope.propertyId, itemIds]
      );
      if (itemResult.rows.length !== lines.length) return { outcome: "invalid_items" as const };
      const itemsById = new Map(itemResult.rows.map((item) => [item.id, item]));

      await run("DELETE FROM purchase_lines WHERE purchase_id = $1 AND property_id = $2", [purchaseId, scope.propertyId]);
      const total = await replaceLines(run, scope.propertyId, purchaseId, lines, itemsById);
      await run(
        `UPDATE purchases
         SET supplier_name = $1, purchase_date = $2::date, total = $3, updated_at = NOW()
         WHERE id = $4 AND property_id = $5`,
        [supplierName, purchaseDate, total, purchaseId, scope.propertyId]
      );
      await run(
        `INSERT INTO audit_log
           (company_id, property_id, outlet_id, actor_user_id, action_type, resource_type, resource_id, payload_before, payload_after)
         VALUES ($1, $2, $3, $4, 'PURCHASE.DRAFT.UPDATE', 'purchases', $5, $6::jsonb, $7::jsonb)`,
        [auth.bundle.company.id, scope.propertyId, outletId, auth.userId, purchaseId,
          JSON.stringify({ supplier_name: current.supplier_name, total: Number(current.total) }),
          JSON.stringify({ supplier_name: supplierName, purchase_date: purchaseDate, total: Number(total) })]
      );
      return { outcome: "ok" as const };
    });
    if (result.outcome === "not_found") return errorResponse("The purchase was not found.", 404);
    if (result.outcome === "locked") return errorResponse("Only draft purchases can be edited.", 409);
    if (result.outcome === "invalid_items") return errorResponse("One or more selected products are inactive or do not track stock.", 400);
    return NextResponse.json({ success: true, message: "Purchase draft updated." });
  } catch (error) {
    console.error("Failed to update a purchase draft.", error);
    return errorResponse("The purchase draft could not be updated.", 500);
  }
}

export async function PATCH(request: Request) {
  if (!databaseReady()) return errorResponse("DATABASE_URL is not configured.", 503);
  const auth = await getAuthContext();
  if (!auth) return errorResponse("Not signed in.", 401);
  const body = await readBody(request);
  if (!body) return errorResponse("Request body must be a valid JSON object.");

  const outletId = typeof body.outlet_id === "string" ? body.outlet_id : "";
  const scope = assertOutletAccess(auth.bundle, outletId);
  if (!scope) return errorResponse("You are not assigned to this outlet.", 403);
  if (!hasPermission(auth.bundle, scope.propertyId, "inventory:manage")) {
    return errorResponse("You do not have permission to manage purchases.", 403);
  }
  const purchaseId = typeof body.purchase_id === "string" ? body.purchase_id : "";
  const action = body.action;
  if (!UUID_PATTERN.test(purchaseId) || (action !== "order" && action !== "receive")) {
    return errorResponse("Choose a valid purchase and action.");
  }

  try {
    const result = await withUserContext(auth.userId, async (run) => {
      const selected = await run<{
        id: string; status: "draft" | "ordered" | "received"; supplier_name: string; total: string;
      }>(
        `SELECT id, status, supplier_name, total::text
         FROM purchases WHERE id = $1 AND property_id = $2 FOR UPDATE`,
        [purchaseId, scope.propertyId]
      );
      const purchase = selected.rows[0];
      if (!purchase) return { outcome: "not_found" as const };
      if (action === "order") {
        if (purchase.status === "ordered") {
          return { outcome: "ok" as const, status: "ordered" as const, duplicate: true };
        }
        if (purchase.status !== "draft") return { outcome: "invalid_status" as const };
        await run(
          `UPDATE purchases SET status = 'ordered', ordered_by = $1, ordered_at = NOW(), updated_at = NOW()
           WHERE id = $2 AND property_id = $3`,
          [auth.userId, purchaseId, scope.propertyId]
        );
        await run(
          `INSERT INTO audit_log
             (company_id, property_id, outlet_id, actor_user_id, action_type, resource_type, resource_id, payload_after)
           VALUES ($1, $2, $3, $4, 'PURCHASE.ORDER', 'purchases', $5, $6::jsonb)`,
          [auth.bundle.company.id, scope.propertyId, outletId, auth.userId, purchaseId,
            JSON.stringify({ status: "ordered", total: Number(purchase.total) })]
        );
        return { outcome: "ok" as const, status: "ordered" as const, duplicate: false };
      }

      if (purchase.status === "received") {
        return { outcome: "ok" as const, status: "received" as const, duplicate: true };
      }
      if (purchase.status !== "ordered") return { outcome: "invalid_status" as const };
      const lines = await run<{
        id: string; item_id: string; item_name: string; quantity: string; unit_cost: string;
        stock_tracked: boolean; is_active: boolean;
      }>(
        `SELECT pl.id, pl.item_id, pl.item_name, pl.quantity::text, pl.unit_cost::text,
                i.stock_tracked, i.is_active
         FROM purchase_lines pl
         JOIN items i ON i.id = pl.item_id AND i.property_id = pl.property_id
         WHERE pl.purchase_id = $1 AND pl.property_id = $2
         ORDER BY i.id
         FOR UPDATE OF i`,
        [purchaseId, scope.propertyId]
      );
      if (lines.rows.length === 0 || lines.rows.some((line) => !line.stock_tracked || !line.is_active)) {
        return { outcome: "invalid_items" as const };
      }

      for (const line of lines.rows) {
        await run(
          `INSERT INTO central_stock_levels (property_id, item_id, quantity)
           VALUES ($1, $2, 0) ON CONFLICT (property_id, item_id) DO NOTHING`,
          [scope.propertyId, line.item_id]
        );
        await run(
          `UPDATE central_stock_levels
           SET quantity = quantity + $1::numeric, updated_at = NOW()
           WHERE property_id = $2 AND item_id = $3`,
          [line.quantity, scope.propertyId, line.item_id]
        );
        await run(
          `INSERT INTO stock_movements
             (property_id, item_id, movement_type, quantity, destination_warehouse,
              unit_cost, supplier_name, reference_type, reference_id, idempotency_key, actor_user_id)
           VALUES ($1, $2, 'purchase_receipt', $3, 'central', $4, $5, 'purchase', $6, $7, $8)`,
          [scope.propertyId, line.item_id, line.quantity, line.unit_cost, purchase.supplier_name,
            purchaseId, `purchase:${purchaseId}:${line.id}`, auth.userId]
        );
      }
      await run(
        `UPDATE purchases
         SET status = 'received', received_by = $1, received_at = NOW(), updated_at = NOW()
         WHERE id = $2 AND property_id = $3`,
        [auth.userId, purchaseId, scope.propertyId]
      );
      await run(
        `INSERT INTO audit_log
           (company_id, property_id, outlet_id, actor_user_id, action_type, resource_type, resource_id, payload_after)
         VALUES ($1, $2, $3, $4, 'PURCHASE.RECEIVE', 'purchases', $5, $6::jsonb)`,
        [auth.bundle.company.id, scope.propertyId, outletId, auth.userId, purchaseId,
          JSON.stringify({ status: "received", total: Number(purchase.total), line_count: lines.rows.length })]
      );
      return { outcome: "ok" as const, status: "received" as const, duplicate: false };
    });

    if (result.outcome === "not_found") return errorResponse("The purchase was not found.", 404);
    if (result.outcome === "invalid_status") {
      return errorResponse(action === "order"
        ? "Only draft purchases can be marked as ordered."
        : "Only ordered purchases can be received.", 409);
    }
    if (result.outcome === "invalid_items") {
      return errorResponse("The purchase contains an inactive or non-stock product and cannot be received.", 409);
    }
    if (result.status === "received") {
      return NextResponse.json({
        success: true,
        message: result.duplicate
          ? "This purchase was already received. Stock was not added again."
          : "Purchase received. All quantities were added to Central Store.",
      });
    }
    return NextResponse.json({
      success: true,
      message: result.duplicate ? "Purchase was already marked as ordered." : "Purchase marked as ordered.",
    });
  } catch (error) {
    console.error("Failed to change purchase status.", error);
    return errorResponse("The purchase status was not changed.", 500);
  }
}

export async function DELETE(request: Request) {
  if (!databaseReady()) return errorResponse("DATABASE_URL is not configured.", 503);
  const auth = await getAuthContext();
  if (!auth) return errorResponse("Not signed in.", 401);
  const body = await readBody(request);
  if (!body) return errorResponse("Request body must be a valid JSON object.");

  const outletId = typeof body.outlet_id === "string" ? body.outlet_id : "";
  const scope = assertOutletAccess(auth.bundle, outletId);
  if (!scope) return errorResponse("You are not assigned to this outlet.", 403);
  if (!hasPermission(auth.bundle, scope.propertyId, "inventory:manage")) {
    return errorResponse("You do not have permission to manage purchases.", 403);
  }
  const purchaseId = typeof body.purchase_id === "string" ? body.purchase_id : "";
  if (!UUID_PATTERN.test(purchaseId)) return errorResponse("Choose a valid purchase.");

  try {
    const outcome = await withUserContext(auth.userId, async (run) => {
      const selected = await run<{
        supplier_name: string; purchase_date: string; total: string; status: string;
      }>(
        `SELECT supplier_name, to_char(purchase_date, 'YYYY-MM-DD') AS purchase_date, total::text, status
         FROM purchases WHERE id = $1 AND property_id = $2 FOR UPDATE`,
        [purchaseId, scope.propertyId]
      );
      const purchase = selected.rows[0];
      if (!purchase) return "not_found" as const;
      if (purchase.status !== "draft") return "locked" as const;
      await run(
        `INSERT INTO audit_log
           (company_id, property_id, outlet_id, actor_user_id, action_type, resource_type, resource_id, payload_before)
         VALUES ($1, $2, $3, $4, 'PURCHASE.DRAFT.DISCARD', 'purchases', $5, $6::jsonb)`,
        [auth.bundle.company.id, scope.propertyId, outletId, auth.userId, purchaseId,
          JSON.stringify({ supplier_name: purchase.supplier_name, purchase_date: purchase.purchase_date, total: Number(purchase.total) })]
      );
      await run("DELETE FROM purchases WHERE id = $1 AND property_id = $2", [purchaseId, scope.propertyId]);
      return "deleted" as const;
    });
    if (outcome === "not_found") return errorResponse("The purchase was not found.", 404);
    if (outcome === "locked") return errorResponse("Only draft purchases can be discarded.", 409);
    return NextResponse.json({ success: true, message: "Purchase draft discarded." });
  } catch (error) {
    console.error("Failed to discard a purchase draft.", error);
    return errorResponse("The purchase draft could not be discarded.", 500);
  }
}
