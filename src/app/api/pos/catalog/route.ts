import { NextResponse } from "next/server";
import { databaseReady, withUserContext } from "@/lib/db/postgres";
import { assertOutletAccess, getAuthContext, hasPermission } from "@/lib/auth/require-session";
import type { QueryResultRow } from "pg";

export const runtime = "nodejs";

interface ItemRow extends QueryResultRow {
  id: string;
  property_id: string;
  outlet_id: string;
  name: string;
  sku: string;
  unit: string;
  barcode: string | null;
  category: string | null;
  price: string;
  reorder_level: string;
  stock_tracked: boolean;
  is_active: boolean;
  item_type: "retail" | "menu" | "supply";
  prep_station: "kitchen" | "bar";
  kitchen_quantity: string | null;
  bar_quantity: string | null;
  supplies_quantity: string | null;
  etims_item_code: string | null;
  etims_tax_code: string | null;
  etims_qty_unit_code: string | null;
  etims_pkg_unit_code: string | null;
  etims_item_class_code: string | null;
}

export async function GET(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });

  const outletId = new URL(request.url).searchParams.get("outlet_id");
  if (!outletId) return NextResponse.json({ success: false, message: "outlet_id is required." }, { status: 400 });

  const scope = assertOutletAccess(auth.bundle, outletId);
  if (!scope) return NextResponse.json({ success: false, message: "You are not assigned to this outlet." }, { status: 403 });
  const canReadCatalog = hasPermission(auth.bundle, scope.propertyId, "pos:read") ||
    hasPermission(auth.bundle, scope.propertyId, "catalog:read") ||
    hasPermission(auth.bundle, scope.propertyId, "inventory:read");
  if (!canReadCatalog) {
    return NextResponse.json({ success: false, message: "You do not have permission to view this catalog." }, { status: 403 });
  }
  const includeSupplies = new URL(request.url).searchParams.get("include_supplies") === "true";
  if (includeSupplies && !hasPermission(auth.bundle, scope.propertyId, "catalog:read")) {
    return NextResponse.json({ success: false, message: "You do not have permission to view supply catalog items." }, { status: 403 });
  }
  const canReadInventory = hasPermission(auth.bundle, scope.propertyId, "inventory:read");
  const canReadPos = hasPermission(auth.bundle, scope.propertyId, "pos:read");

  const items = await withUserContext(auth.userId, async (run) => {
    const result = await run<ItemRow>(
      `SELECT i.id, i.property_id, io.outlet_id, i.name, i.sku, i.barcode, c.name AS category,
              i.unit, i.price, i.reorder_level, i.stock_tracked, i.is_active, i.item_type, i.prep_station,
              kitchen_stock.quantity AS kitchen_quantity, bar_stock.quantity AS bar_quantity,
              supplies_stock.quantity AS supplies_quantity,
              i.etims_item_code, i.etims_tax_code, i.etims_qty_unit_code,
              i.etims_pkg_unit_code, i.etims_item_class_code
       FROM item_outlets io
       JOIN items i ON i.id = io.item_id AND i.property_id = io.property_id
       LEFT JOIN categories c ON c.id = i.category_id
       LEFT JOIN stock_levels kitchen_stock
         ON kitchen_stock.item_id = i.id AND kitchen_stock.outlet_id = io.outlet_id AND kitchen_stock.warehouse = 'kitchen'
       LEFT JOIN stock_levels bar_stock
         ON bar_stock.item_id = i.id AND bar_stock.outlet_id = io.outlet_id AND bar_stock.warehouse = 'bar'
       LEFT JOIN stock_levels supplies_stock
         ON supplies_stock.item_id = i.id AND supplies_stock.outlet_id = io.outlet_id AND supplies_stock.warehouse = 'supplies'
       WHERE io.outlet_id = $1 AND
         (i.item_type IN ('retail', 'menu') OR ($2::boolean AND i.item_type = 'supply'))
       ORDER BY i.name`,
      [outletId, includeSupplies]
    );
    return result.rows;
  });

  return NextResponse.json({
    success: true,
    items: items.map((row) => {
      const stockByWarehouse = {
        kitchen: Number(row.kitchen_quantity ?? 0),
        bar: Number(row.bar_quantity ?? 0),
        supplies: Number(row.supplies_quantity ?? 0),
      };
      const assignedStock = row.item_type === "supply" ? stockByWarehouse.supplies : stockByWarehouse[row.prep_station];
      return {
        id: row.id,
        property_id: row.property_id,
        outlet_id: row.outlet_id,
        item_type: row.item_type,
        name: row.name,
        sku: row.sku,
        unit: row.unit,
        barcode: row.barcode ?? undefined,
        category: row.category ?? "grocery",
        price: Number(row.price),
        stock: canReadInventory && row.stock_tracked ? assignedStock : 0,
        stock_available: canReadInventory || canReadPos
          ? !row.stock_tracked || assignedStock > 0
          : undefined,
        reorder_level: canReadInventory ? Number(row.reorder_level) : 0,
        stock_tracked: row.stock_tracked,
        is_active: row.is_active,
        prep_station: row.prep_station,
        etims_item_code: row.etims_item_code,
        etims_tax_code: row.etims_tax_code,
        etims_qty_unit_code: row.etims_qty_unit_code,
        etims_pkg_unit_code: row.etims_pkg_unit_code,
        etims_item_class_code: row.etims_item_class_code,
        ...(canReadInventory ? { stock_by_warehouse: stockByWarehouse } : {}),
      };
    }),
  });
}

interface EtimsMappingBody {
  outlet_id?: string;
  item_id?: string;
  etims_item_code?: string | null;
  etims_tax_code?: string | null;
  etims_qty_unit_code?: string | null;
  etims_pkg_unit_code?: string | null;
  etims_item_class_code?: string | null;
}

export async function PATCH(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });

  let body: EtimsMappingBody;
  try {
    body = await request.json() as EtimsMappingBody;
  } catch {
    return NextResponse.json({ success: false, message: "Request body must be valid JSON." }, { status: 400 });
  }
  if (!body.outlet_id || !body.item_id) return NextResponse.json({ success: false, message: "outlet_id and item_id are required." }, { status: 400 });
  const limits: Array<[string | null | undefined, number]> = [
    [body.etims_item_code, 80], [body.etims_tax_code, 10],
    [body.etims_qty_unit_code, 20], [body.etims_pkg_unit_code, 20],
    [body.etims_item_class_code, 40],
  ];
  if (limits.some(([value, maximum]) => value !== undefined && value !== null &&
      (typeof value !== "string" || value.trim().length > maximum)) ||
      (body.etims_tax_code?.trim() && !/^[ABCDE]$/.test(body.etims_tax_code.trim()))) {
    return NextResponse.json({ success: false, message: "Enter valid eTIMS mapping values. Tax code must be A, B, C, D, or E." }, { status: 400 });
  }
  const scope = assertOutletAccess(auth.bundle, body.outlet_id);
  if (!scope) return NextResponse.json({ success: false, message: "You are not assigned to this outlet." }, { status: 403 });
  if (!hasPermission(auth.bundle, scope.propertyId, "catalog:manage")) {
    return NextResponse.json({ success: false, message: "You do not have permission to manage catalog items." }, { status: 403 });
  }
  try {
    const result = await withUserContext(auth.userId, (run) => run(
      `UPDATE items i SET
         etims_item_code = $3, etims_tax_code = $4, etims_qty_unit_code = $5,
         etims_pkg_unit_code = $6, etims_item_class_code = $7, updated_at = NOW()
       WHERE i.id = $1 AND i.property_id = $2
         AND EXISTS (SELECT 1 FROM item_outlets io WHERE io.item_id = i.id AND io.outlet_id = $8)
       RETURNING i.id`,
      [body.item_id, scope.propertyId, body.etims_item_code?.trim() || null,
        body.etims_tax_code?.trim() || null, body.etims_qty_unit_code?.trim() || null,
        body.etims_pkg_unit_code?.trim() || null, body.etims_item_class_code?.trim() || null,
        body.outlet_id],
    ));
    if (result.rowCount === 0) return NextResponse.json({ success: false, message: "Catalog item not found in this outlet." }, { status: 404 });
    return NextResponse.json({ success: true, message: "eTIMS product mapping saved." });
  } catch (error) {
    console.error("Failed to update eTIMS catalog mapping.", error);
    return NextResponse.json({ success: false, message: "The eTIMS product mapping could not be saved." }, { status: 500 });
  }
}

interface CreateItemBody {
  outlet_id?: string;
  name?: string;
  item_type?: "retail" | "supply";
  unit?: string;
  barcode?: string;
  category?: string;
  price?: number;
  reorder_level?: number;
  initial_stock_kitchen?: number;
  initial_stock_bar?: number;
  stock_tracked?: boolean;
  prep_station?: "kitchen" | "bar";
}

export async function POST(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });

  let body: CreateItemBody;
  try {
    body = (await request.json()) as CreateItemBody;
  } catch {
    return NextResponse.json({ success: false, message: "Request body must be valid JSON." }, { status: 400 });
  }

  const initialKitchenStock = body.initial_stock_kitchen ?? 0;
  const initialBarStock = body.initial_stock_bar ?? 0;
  const reorderLevel = body.reorder_level ?? 0;
  const stockTracked = body.stock_tracked ?? true;
  const itemType = body.item_type ?? "retail";
  const prepStation = body.prep_station ?? "kitchen";
  if (!body.outlet_id || !body.name?.trim() ||
      typeof body.price !== "number" || !Number.isFinite(body.price) || body.price < 0 ||
      typeof initialKitchenStock !== "number" || !Number.isFinite(initialKitchenStock) || initialKitchenStock < 0 ||
      typeof initialBarStock !== "number" || !Number.isFinite(initialBarStock) || initialBarStock < 0 ||
      typeof reorderLevel !== "number" || !Number.isFinite(reorderLevel) || reorderLevel < 0 ||
      (body.stock_tracked !== undefined && typeof body.stock_tracked !== "boolean") ||
      (itemType !== "retail" && itemType !== "supply") ||
      (prepStation !== "kitchen" && prepStation !== "bar")) {
    return NextResponse.json({ success: false, message: "outlet_id, name, and a non-negative price are required." }, { status: 400 });
  }
  if (!stockTracked && (initialKitchenStock > 0 || initialBarStock > 0 || reorderLevel > 0)) {
    return NextResponse.json({ success: false, message: "Non-stock items cannot have opening stock or a reorder level." }, { status: 400 });
  }
  if (itemType === "supply" && (!stockTracked || initialKitchenStock > 0 || initialBarStock > 0)) {
    return NextResponse.json({ success: false, message: "Supply items must be stock-tracked and cannot use Kitchen or Bar opening balances." }, { status: 400 });
  }

  const scope = assertOutletAccess(auth.bundle, body.outlet_id);
  if (!scope) return NextResponse.json({ success: false, message: "You are not assigned to this outlet." }, { status: 403 });
  if (!hasPermission(auth.bundle, scope.propertyId, "catalog:manage")) {
    return NextResponse.json({ success: false, message: "You do not have permission to add catalog items." }, { status: 403 });
  }
  if ((initialKitchenStock > 0 || initialBarStock > 0 || reorderLevel > 0) &&
      !hasPermission(auth.bundle, scope.propertyId, "inventory:manage")) {
    return NextResponse.json({ success: false, message: "Initial stock requires stock-management permission." }, { status: 403 });
  }

  const name = body.name.trim();
  const unit = body.unit?.trim() || "each";
  if (unit.length > 40) {
    return NextResponse.json({ success: false, message: "Unit must be 40 characters or fewer." }, { status: 400 });
  }

  try {
    const item = await withUserContext(auth.userId, async (run) => {
      let categoryId: string | null = null;
      if (body.category?.trim()) {
        const categoryResult = await run<{ id: string }>(
          `INSERT INTO categories (property_id, name) VALUES ($1, $2)
           ON CONFLICT (property_id, name) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [scope.propertyId, body.category.trim()]
        );
        categoryId = categoryResult.rows[0]?.id ?? null;
      }

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
        const existingSku = await run<{ id: string }>(
          `SELECT id FROM items WHERE property_id = $1 AND sku = $2 LIMIT 1`,
          [scope.propertyId, candidate]
        );
        if (!existingSku.rows[0]) sku = candidate;
      }

      const itemResult = await run<{ id: string }>(
        `INSERT INTO items (property_id, outlet_id, category_id, name, sku, barcode, item_type, price, stock_tracked, reorder_level, prep_station, unit)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [scope.propertyId, body.outlet_id, categoryId, name, sku, body.barcode?.trim() || null, itemType, body.price, stockTracked, reorderLevel, prepStation, unit]
      );
      const itemId = itemResult.rows[0].id;

      await run(
        `INSERT INTO item_outlets (property_id, outlet_id, item_id) VALUES ($1, $2, $3)`,
        [scope.propertyId, body.outlet_id, itemId]
      );
      await run(
        `INSERT INTO central_stock_levels (property_id, item_id, quantity) VALUES ($1, $2, 0)`,
        [scope.propertyId, itemId]
      );

      if (stockTracked) {
        if (itemType === "supply") {
          await run(
            `INSERT INTO stock_levels (property_id, outlet_id, item_id, warehouse, quantity)
             VALUES ($1, $2, $3, 'supplies', 0)`,
            [scope.propertyId, body.outlet_id, itemId]
          );
        } else {
          await run(
            `INSERT INTO stock_levels (property_id, outlet_id, item_id, warehouse, quantity)
             VALUES ($1, $2, $3, 'kitchen', $4), ($1, $2, $3, 'bar', $5)
             ON CONFLICT (outlet_id, item_id, warehouse) DO UPDATE SET quantity = EXCLUDED.quantity`,
            [scope.propertyId, body.outlet_id, itemId, initialKitchenStock, initialBarStock]
          );
          for (const [warehouse, quantity] of [["kitchen", initialKitchenStock], ["bar", initialBarStock]] as const) {
            if (quantity <= 0) continue;
            await run(
              `INSERT INTO stock_movements
                 (property_id, item_id, movement_type, quantity, destination_outlet_id, destination_warehouse,
                  reference_type, reference_id, idempotency_key, actor_user_id)
               VALUES ($1, $2, 'opening_balance', $3, $4, $5, 'catalog_item', $2, $6, $7)`,
              [scope.propertyId, itemId, quantity, body.outlet_id, warehouse, `catalog-opening:${itemId}:${warehouse}`, auth.userId]
            );
          }
        }
      }

      return { id: itemId, sku };
    });

    return NextResponse.json({
      success: true,
      message: `Item added to catalog with SKU ${item.sku}.`,
      item,
    });
  } catch (error) {
    const message = error instanceof Error && /uq_property_item_sku/.test(error.message)
      ? "A unique SKU could not be reserved. Please retry item creation."
      : "Could not create the item.";
    return NextResponse.json({ success: false, message }, { status: 400 });
  }
}
