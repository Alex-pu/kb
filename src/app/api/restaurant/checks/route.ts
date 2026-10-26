import { NextResponse } from "next/server";
import type { QueryResultRow } from "pg";
import { assertOutletAccess, getAuthContext, hasPermission } from "@/lib/auth/require-session";
import { databaseReady, withUserContext } from "@/lib/db/postgres";
import type { CatalogItem, Kot, KotStatus, PrepStation, ProductCategory, TenderLine } from "@/lib/types/database";
import { fiscalizeRestaurantBill } from "@/lib/etims/restaurant-bills";

export const runtime = "nodejs";

interface MenuRow extends QueryResultRow {
  id: string;
  property_id: string;
  outlet_id: string;
  name: string;
  sku: string;
  unit: string;
  barcode: string | null;
  category: string | null;
  price: string;
  stock_tracked: boolean;
  is_active: boolean;
  prep_station: "kitchen" | "bar";
}

interface CheckRow extends QueryResultRow {
  id: string;
  bill_number: string;
  table_ref: string;
  table_name: string;
  shift_id: string;
  cashier_id: string;
  cashier_name: string;
  waiter_id: string;
  waiter_name: string;
  lines: PersistedLine[];
  total: string;
  created_at: string;
  updated_at: string;
  callback_transaction_code?: string | null;
}

interface PersistedLine {
  item: CatalogItem;
  quantity: number;
  round: number;
  sentToKitchen: boolean;
  instructions?: string;
}

interface RestaurantKotRow extends QueryResultRow {
  id: string;
  check_id: string;
  table_ref: string;
  table_name: string;
  round: number;
  station: PrepStation;
  status: KotStatus;
  lines: Kot["lines"];
  created_at: string;
  cancel_reason: string | null;
}

interface CheckRequest {
  action?: unknown;
  outlet_id?: unknown;
  table_id?: unknown;
  table_name?: unknown;
  lines?: unknown;
  check_id?: unknown;
  tenders?: unknown;
  idempotency_key?: unknown;
  callback_transaction_code?: unknown;
  create_kots?: unknown;
}

interface RawLine {
  item_id: string;
  quantity: number;
  round: number;
  sent_to_kitchen: boolean;
  instructions?: string;
}

function kotDto(row: RestaurantKotRow): Kot {
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function categoryForItem(category: string | null): ProductCategory {
  if (category === "grocery" || category === "hardware" || category === "beverage" || category === "household" || category === "food") {
    return category;
  }
  return "food";
}

function menuItem(row: MenuRow): CatalogItem {
  const category = categoryForItem(row.category);
  return {
    id: row.id,
    property_id: row.property_id,
    outlet_id: row.outlet_id,
    name: row.name,
    sku: row.sku,
    unit: row.unit,
    barcode: row.barcode ?? undefined,
    category,
    price: Number(row.price),
    stock: 0,
    reorder_level: 0,
    stock_tracked: row.stock_tracked,
    is_active: row.is_active,
    prep_station: row.prep_station,
  };
}

function parseLines(value: unknown): RawLine[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) return null;
  const lines: RawLine[] = [];
  for (const line of value) {
    if (typeof line !== "object" || line === null) return null;
    const candidate = line as Record<string, unknown>;
    if (typeof candidate.item_id !== "string" || !UUID_PATTERN.test(candidate.item_id) ||
        typeof candidate.quantity !== "number" || !Number.isFinite(candidate.quantity) ||
        candidate.quantity <= 0 || candidate.quantity > 10000 ||
        typeof candidate.round !== "number" || !Number.isInteger(candidate.round) || candidate.round < 1 ||
        typeof candidate.sent_to_kitchen !== "boolean" ||
        (candidate.instructions !== undefined && (typeof candidate.instructions !== "string" || candidate.instructions.length > 500))) return null;
    lines.push({
      item_id: candidate.item_id,
      quantity: candidate.quantity,
      round: candidate.round,
      sent_to_kitchen: candidate.sent_to_kitchen,
      instructions: typeof candidate.instructions === "string" ? candidate.instructions.trim() || undefined : undefined,
    });
  }
  return lines;
}

function parseTenders(value: unknown): TenderLine[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) return null;
  const tenders: TenderLine[] = [];
  const tenderTypes = new Set<string>();
  for (const tender of value) {
    if (typeof tender !== "object" || tender === null) return null;
    const candidate = tender as Record<string, unknown>;
    if ((candidate.type !== "cash" && candidate.type !== "mpesa" && candidate.type !== "card") ||
        typeof candidate.amount !== "number" || !Number.isFinite(candidate.amount) || candidate.amount <= 0 ||
        (candidate.reference !== undefined && typeof candidate.reference !== "string") ||
        tenderTypes.has(candidate.type)) return null;
    tenderTypes.add(candidate.type);
    const reference = typeof candidate.reference === "string" ? candidate.reference.trim() : undefined;
    if (candidate.type === "mpesa" && !reference) return null;
    tenders.push({ type: candidate.type, amount: candidate.amount, reference });
  }
  return tenders;
}

async function readBody(request: Request): Promise<CheckRequest | null> {
  try {
    const value: unknown = await request.json();
    return typeof value === "object" && value !== null ? value as CheckRequest : null;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });

  const outletId = new URL(request.url).searchParams.get("outlet_id");
  if (!outletId) return NextResponse.json({ success: false, message: "outlet_id is required." }, { status: 400 });
  const scope = assertOutletAccess(auth.bundle, outletId);
  if (!scope) return NextResponse.json({ success: false, message: "You are not assigned to this outlet." }, { status: 403 });
  if (!hasPermission(auth.bundle, scope.propertyId, "restaurant:read")) {
    return NextResponse.json({ success: false, message: "You do not have permission to view restaurant checks." }, { status: 403 });
  }

  try {
    const data = await withUserContext(auth.userId, async (run) => {
      const [menuResult, checksResult] = await Promise.all([
        run<MenuRow>(
          `SELECT i.id, i.property_id, io.outlet_id, i.name, i.sku, i.barcode,
                  i.unit, c.name AS category, i.price, i.stock_tracked, i.is_active, i.prep_station
           FROM items i
           JOIN item_outlets io ON io.item_id = i.id AND io.property_id = i.property_id
           LEFT JOIN categories c ON c.id = i.category_id
           WHERE io.outlet_id = $1 AND i.is_active = TRUE AND i.item_type <> 'supply'
           ORDER BY i.name`,
          [outletId]
        ),
        run<CheckRow>(
          `SELECT rc.id, rc.bill_number, rc.table_ref, rc.table_name, rc.shift_id, rc.cashier_id,
                  cashier.full_name AS cashier_name, rc.waiter_id, waiter.full_name AS waiter_name,
                  rc.lines, rc.total, rc.created_at, rc.updated_at,
                  callback.transaction_code AS callback_transaction_code
           FROM restaurant_checks rc
           JOIN users cashier ON cashier.id = rc.cashier_id
           JOIN users waiter ON waiter.id = rc.waiter_id
           LEFT JOIN LATERAL (
             SELECT payment.transaction_code
             FROM daraja_payments payment
             WHERE payment.property_id = rc.property_id
               AND payment.outlet_id = rc.outlet_id
               AND payment.status = 'paid'
               AND payment.applied_at IS NULL
               AND payment.bill_reference = rc.bill_number
               AND payment.order_id = rc.bill_number
             ORDER BY payment.created_at
             LIMIT 1
           ) callback ON TRUE
           WHERE rc.outlet_id = $1 AND rc.status = 'open'
           ORDER BY rc.created_at`,
          [outletId]
        ),
      ]);
      return {
        menu: menuResult.rows.map(menuItem),
        checks: checksResult.rows.map((row) => ({
          id: row.id,
          bill_number: row.bill_number,
          table_id: row.table_ref,
          table_name: row.table_name,
          shift_id: row.shift_id,
          cashier_id: row.cashier_id,
          cashier_name: row.cashier_name,
          waiter_id: row.waiter_id,
          waiter_name: row.waiter_name,
          lines: row.lines,
          total: Number(row.total),
          callback_transaction_code: row.callback_transaction_code ?? null,
          created_at: row.created_at,
          updated_at: row.updated_at,
        })),
      };
    });
    return NextResponse.json({ success: true, ...data });
  } catch (error) {
    console.error("Failed to load restaurant checks.", error);
    return NextResponse.json({ success: false, message: "Restaurant checks could not be loaded." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });
  const body = await readBody(request);
  if (!body) return NextResponse.json({ success: false, message: "Request body must be a valid JSON object." }, { status: 400 });

  const outletId = typeof body.outlet_id === "string" ? body.outlet_id : "";
  const tableId = typeof body.table_id === "string" ? body.table_id.trim() : "";
  const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
  const action = body.action;
  const createKots = body.create_kots === true;
  if (!outletId || !tableId || tableId.length > 100 || !tableName || tableName.length > 100 ||
      (action !== "save" && action !== "settle" && action !== "settle_callback" && action !== "void") ||
      (body.create_kots !== undefined && typeof body.create_kots !== "boolean") ||
      (createKots && action !== "save")) {
    return NextResponse.json({ success: false, message: "A valid outlet, table, and restaurant-check action are required." }, { status: 400 });
  }

  const scope = assertOutletAccess(auth.bundle, outletId);
  if (!scope) return NextResponse.json({ success: false, message: "You are not assigned to this outlet." }, { status: 403 });
  const canSettleRestaurant = hasPermission(auth.bundle, scope.propertyId, "restaurant:settle");
  const canOperateRestaurant = hasPermission(auth.bundle, scope.propertyId, "restaurant:write");
  const canClearVerifiedCallback = canSettleRestaurant || canOperateRestaurant;
  if ((action === "settle" && !canSettleRestaurant) ||
      (action === "settle_callback" && !canClearVerifiedCallback) ||
      ((action === "save" || action === "void") && !canOperateRestaurant)) {
    return NextResponse.json({ success: false, message: action === "settle"
      ? "Only an authorized cashier can clear waiter bills."
      : "You do not have permission to update restaurant checks." }, { status: 403 });
  }

  const lines = action === "save" ? parseLines(body.lines) : null;
  const tenders = action === "settle" ? parseTenders(body.tenders) : null;
  const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
  const callbackTransactionCode = typeof body.callback_transaction_code === "string"
    ? body.callback_transaction_code.trim().toUpperCase()
    : "";
  if ((action === "save" && !lines) ||
      (action === "settle" && (!tenders || !idempotencyKey || idempotencyKey.length > 160)) ||
      (action === "settle_callback" && !callbackTransactionCode) ||
      (action === "void" && body.lines !== undefined)) {
    return NextResponse.json({ success: false, message: "The restaurant-check details are invalid." }, { status: 400 });
  }

  try {
    const result = await withUserContext(auth.userId, async (run) => {
      const shiftResult = await run<{
        id: string; property_id: string; cashier_id: string; cashier_name: string;
      }>(
        `SELECT s.id, s.property_id, s.cashier_id, u.full_name AS cashier_name
         FROM shifts s JOIN users u ON u.id = s.cashier_id
         WHERE s.outlet_id = $1 AND s.status = 'open'
           AND (s.shift_area = 'pos' OR s.shift_area IS NULL)
         ORDER BY s.opened_at DESC LIMIT 1 FOR UPDATE OF s`,
        [outletId]
      );
      const shift = shiftResult.rows[0];
      if (!shift) return { outcome: "no_shift" as const };
      if (shift.property_id !== scope.propertyId) return { outcome: "invalid_scope" as const };

      const existingResult = await run<{
        id: string; bill_number: string; shift_id: string; waiter_id: string; lines: PersistedLine[]; total: string; status: string;
      }>(
        `SELECT id, bill_number, shift_id, waiter_id, lines, total, status
         FROM restaurant_checks
         WHERE outlet_id = $1 AND table_ref = $2 AND status = 'open'
         FOR UPDATE`,
        [outletId, tableId]
      );
      const existing = existingResult.rows[0];
      if (existing && existing.waiter_id !== auth.userId &&
          !((action === "settle" || action === "settle_callback") && canSettleRestaurant)) {
        return { outcome: "not_owner" as const };
      }
      if (existing) {
        const pendingRoomCharge = await run<{ id: string }>(
          `SELECT id FROM restaurant_room_charge_requests
           WHERE check_id = $1 AND status = 'pending'`,
          [existing.id],
        );
        if (pendingRoomCharge.rows[0]) return { outcome: "pending_room_charge" as const };
      }
      if (existing && existing.shift_id !== shift.id && action !== "settle" && action !== "settle_callback") {
        return { outcome: "different_shift" as const };
      }
      if (!existing && action === "settle") {
        const priorSettlement = await run<{ id: string }>(
          `SELECT rc.id
           FROM restaurant_checks rc
           JOIN restaurant_check_payments rcp ON rcp.check_id = rc.id
           WHERE rc.outlet_id = $1 AND rc.table_ref = $2
             AND rc.status = 'settled' AND rcp.idempotency_key = $3
           LIMIT 1`,
          [outletId, tableId, idempotencyKey]
        );
        if (priorSettlement.rows[0]) return { outcome: "already_settled" as const };
      }
      if (action !== "save" && !existing) return { outcome: "not_found" as const };

      if (action === "save" && lines) {
        const itemIds = Array.from(new Set(lines.map((line) => line.item_id)));
        const itemResult = await run<MenuRow>(
          `SELECT i.id, i.property_id, io.outlet_id, i.name, i.sku, i.barcode,
                  i.unit, c.name AS category, i.price, i.stock_tracked, i.is_active, i.prep_station
           FROM items i
           JOIN item_outlets io ON io.item_id = i.id AND io.property_id = i.property_id
           LEFT JOIN categories c ON c.id = i.category_id
           WHERE i.id = ANY($1::uuid[]) AND io.outlet_id = $2
             AND i.is_active = TRUE AND i.item_type <> 'supply'`,
          [itemIds, outletId]
        );
        const items = new Map(itemResult.rows.map((row) => [row.id, row]));
        if (items.size !== itemIds.length) return { outcome: "invalid_items" as const };

        if (existing) {
          const existingLines = existing.lines ?? [];
          const immutableLines = existingLines.filter((line) => line.sentToKitchen);
          const changedSentLine = immutableLines.some((oldLine) => {
            const nextLine = lines.find((line) =>
              line.item_id === oldLine.item.id && line.round === oldLine.round
            );
            return !nextLine || !nextLine.sent_to_kitchen || nextLine.quantity !== oldLine.quantity ||
              (nextLine.instructions ?? "") !== (oldLine.instructions ?? "");
          });
          if (changedSentLine) return { outcome: "sent_items_locked" as const };
        }

        const persistedLines: PersistedLine[] = lines.map((line) => {
          const item = items.get(line.item_id)!;
          const snapshot = menuItem(item);
          return {
            item: snapshot,
            quantity: line.quantity,
            round: line.round,
            sentToKitchen: line.sent_to_kitchen,
            instructions: line.instructions,
          };
        });
        const total = Math.round(persistedLines.reduce((sum, line) => sum + line.item.price * line.quantity, 0) * 100) / 100;
        const persistKots = async (checkId: string): Promise<Kot[]> => {
          if (!createKots) return [];
          const sentLines = persistedLines.filter((line) => line.sentToKitchen && line.item.prep_station !== "bar");
          const rounds = Array.from(new Set(sentLines.map((line) => line.round)));
          if (rounds.length === 0) return [];

          const groupedLines = new Map<string, {
            round: number;
            station: PrepStation;
            lines: Kot["lines"];
          }>();
          for (const line of sentLines) {
            const station: PrepStation = "kitchen";
            const key = `${line.round}:${station}`;
            const group = groupedLines.get(key) ?? { round: line.round, station, lines: [] };
            group.lines.push({
              item: line.item,
              quantity: line.quantity,
              instructions: line.instructions,
            });
            groupedLines.set(key, group);
          }

          for (const group of groupedLines.values()) {
            const insertedKot = await run<{ id: string }>(
              `INSERT INTO restaurant_kots
                 (property_id, outlet_id, check_id, table_ref, table_name, round, station, lines)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
               ON CONFLICT (check_id, round, station) DO NOTHING
               RETURNING id`,
              [
                scope.propertyId,
                outletId,
                checkId,
                tableId,
                tableName,
                group.round,
                group.station,
                JSON.stringify(group.lines),
              ]
            );
            if (insertedKot.rows[0]) {
              await run(
                `INSERT INTO audit_log (company_id, property_id, outlet_id, actor_user_id, action_type, resource_type, resource_id, payload_after)
                 VALUES ($1, $2, $3, $4, 'KOT.SEND', 'restaurant_kots', $5, $6::jsonb)`,
                [
                  auth.bundle.company.id,
                  scope.propertyId,
                  outletId,
                  auth.userId,
                  insertedKot.rows[0].id,
                  JSON.stringify({ check_id: checkId, round: group.round, station: group.station, lines: group.lines.length }),
                ]
              );
            }
          }

          const storedKots = await run<RestaurantKotRow>(
            `SELECT id, check_id, table_ref, table_name, round, station, status, lines, created_at, cancel_reason
             FROM restaurant_kots
             WHERE check_id = $1 AND round = ANY($2::int[]) AND station = 'kitchen'
             ORDER BY round, station`,
            [checkId, rounds]
          );
          return storedKots.rows.map(kotDto);
        };

        if (existing) {
          await run(
            `UPDATE restaurant_checks
             SET table_name = $1, lines = $2::jsonb, total = $3, updated_at = NOW()
             WHERE id = $4`,
            [tableName, JSON.stringify(persistedLines), total, existing.id]
          );
          await run(
            `INSERT INTO audit_log (company_id, property_id, outlet_id, actor_user_id, action_type, resource_type, resource_id, payload_after)
             VALUES ($1, $2, $3, $4, 'RESTAURANT_CHECK.UPDATE', 'restaurant_checks', $5, $6::jsonb)`,
            [auth.bundle.company.id, scope.propertyId, outletId, auth.userId, existing.id, JSON.stringify({ total, lines: persistedLines.length })]
          );
          const kots = await persistKots(existing.id);
          return {
            outcome: "saved" as const,
            check_id: existing.id,
            bill_number: existing.bill_number,
            total,
            shift_id: shift.id,
            cashier_id: shift.cashier_id,
            cashier_name: shift.cashier_name,
            waiter_id: auth.userId,
            waiter_name: auth.bundle.user.full_name,
            kots,
          };
        }

        const inserted = await run<{ id: string; bill_number: string }>(
          `INSERT INTO restaurant_checks
             (property_id, outlet_id, table_ref, table_name, shift_id, cashier_id, waiter_id, lines, total)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
           RETURNING id, bill_number`,
          [scope.propertyId, outletId, tableId, tableName, shift.id, shift.cashier_id, auth.userId, JSON.stringify(persistedLines), total]
        );
        await run(
          `INSERT INTO audit_log (company_id, property_id, outlet_id, actor_user_id, action_type, resource_type, resource_id, payload_after)
           VALUES ($1, $2, $3, $4, 'RESTAURANT_CHECK.OPEN', 'restaurant_checks', $5, $6::jsonb)`,
          [auth.bundle.company.id, scope.propertyId, outletId, auth.userId, inserted.rows[0].id, JSON.stringify({ total, lines: persistedLines.length, shift_id: shift.id, cashier_id: shift.cashier_id })]
        );
        const kots = await persistKots(inserted.rows[0].id);
        return {
          outcome: "saved" as const,
          check_id: inserted.rows[0].id,
          bill_number: inserted.rows[0].bill_number,
          total,
          shift_id: shift.id,
          cashier_id: shift.cashier_id,
          cashier_name: shift.cashier_name,
          waiter_id: auth.userId,
          waiter_name: auth.bundle.user.full_name,
          kots,
        };
      }

      if (!existing) return { outcome: "not_found" as const };

      let settlementTenders = tenders;
      let settlementIdempotencyKey = idempotencyKey;
      const callbackPaymentIds: string[] = [];
      if (action === "settle_callback") {
        const paymentResult = await run<{ id: string; amount: string }>(
          `SELECT id, amount
           FROM daraja_payments
           WHERE property_id = $1 AND outlet_id = $2
             AND status = 'paid' AND transaction_code = $3
             AND bill_reference = $4 AND order_id = $4 AND applied_at IS NULL
           FOR UPDATE`,
          [scope.propertyId, outletId, callbackTransactionCode, existing.bill_number],
        );
        const payment = paymentResult.rows[0];
        if (!payment) return { outcome: "callback_not_matched" as const };
        if (Math.abs(Number(payment.amount) - Number(existing.total)) > 0.009) {
          return { outcome: "callback_amount_mismatch" as const, total: Number(existing.total) };
        }
        settlementTenders = [{
          type: "mpesa",
          amount: Number(payment.amount),
          reference: callbackTransactionCode,
        }];
        settlementIdempotencyKey = `daraja:${payment.id}`;
        callbackPaymentIds.push(payment.id);
      } else if (action === "settle") {
        for (const tender of settlementTenders ?? []) {
          if (tender.type !== "mpesa") continue;
          const paymentResult = await run<{ id: string; amount: string }>(
            `SELECT id, amount
             FROM daraja_payments
             WHERE property_id = $1 AND (outlet_id = $2 OR outlet_id IS NULL)
               AND status = 'paid' AND transaction_code = $3
               AND bill_reference = $4 AND order_id = $4
               AND applied_at IS NULL
             FOR UPDATE`,
            [scope.propertyId, outletId, tender.reference?.trim().toUpperCase() ?? "", existing.bill_number],
          );
          const payment = paymentResult.rows[0];
          if (!payment) return { outcome: "callback_not_matched" as const };
          if (Math.abs(Number(payment.amount) - tender.amount) > 0.009) {
            return { outcome: "callback_amount_mismatch" as const, total: Number(existing.total) };
          }
          callbackPaymentIds.push(payment.id);
        }
      }

      if (action === "void") {
        if (existing.lines.some((line) => line.sentToKitchen)) return { outcome: "sent_items_locked" as const };
        await run(
          `UPDATE restaurant_checks SET status = 'voided', updated_at = NOW() WHERE id = $1`,
          [existing.id]
        );
        await run(
          `INSERT INTO audit_log (company_id, property_id, outlet_id, actor_user_id, action_type, resource_type, resource_id)
           VALUES ($1, $2, $3, $4, 'RESTAURANT_CHECK.VOID', 'restaurant_checks', $5)`,
          [auth.bundle.company.id, scope.propertyId, outletId, auth.userId, existing.id]
        );
        return { outcome: "voided" as const, check_id: existing.id };
      }

      const priorPayment = await run<{ id: string }>(
        `SELECT id FROM restaurant_check_payments WHERE check_id = $1 AND idempotency_key = $2 LIMIT 1`,
        [existing.id, settlementIdempotencyKey]
      );
      if (priorPayment.rows[0]) return { outcome: "already_settled" as const };
      if (existing.status !== "open") return { outcome: "already_settled" as const };

      const totalTendered = settlementTenders!.reduce((sum, tender) => sum + tender.amount, 0);
      const total = Number(existing.total);
      if (Math.abs(totalTendered - total) > 0.009) {
        return { outcome: "tender_mismatch" as const, total };
      }

      const stockDemand = new Map<string, {
        itemId: string;
        itemName: string;
        warehouse: "kitchen" | "bar";
        quantity: number;
      }>();
      for (const line of existing.lines ?? []) {
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
        const stockResult = await run<{ quantity: string }>(
          `SELECT quantity
           FROM stock_levels
           WHERE outlet_id = $1 AND item_id = $2 AND warehouse = $3
           FOR UPDATE`,
          [outletId, demand.itemId, demand.warehouse]
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
      for (const demand of stockDemand.values()) {
        await run(
          `UPDATE stock_levels
           SET quantity = quantity - $1, updated_at = NOW()
           WHERE outlet_id = $2 AND item_id = $3 AND warehouse = $4`,
          [demand.quantity, outletId, demand.itemId, demand.warehouse]
        );
        await run(
          `INSERT INTO stock_movements
             (property_id, item_id, movement_type, quantity, source_outlet_id, source_warehouse,
              reference_type, reference_id, idempotency_key, actor_user_id)
           VALUES ($1, $2, 'restaurant_sale', $3, $4, $5, 'restaurant_check', $6, $7, $8)`,
          [
            scope.propertyId,
            demand.itemId,
            demand.quantity,
            outletId,
            demand.warehouse,
            existing.id,
            `restaurant-sale:${existing.id}:${demand.itemId}:${demand.warehouse}`,
            auth.userId,
          ]
        );
      }

      for (const tender of settlementTenders!) {
        await run(
          `INSERT INTO restaurant_check_payments
             (property_id, check_id, tender_type, amount, reference, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [scope.propertyId, existing.id, tender.type, tender.amount, tender.reference ?? null, settlementIdempotencyKey]
        );
      }
      const cashTotal = settlementTenders!.filter((tender) => tender.type === "cash").reduce((sum, tender) => sum + tender.amount, 0);
      if (cashTotal > 0) {
        await run(`UPDATE shifts SET cash_sales = cash_sales + $1 WHERE id = $2`, [cashTotal, shift.id]);
      }
      if (callbackPaymentIds.length) {
        await run(
          `UPDATE daraja_payments SET applied_at = NOW(), updated_at = NOW()
           WHERE id = ANY($1::uuid[])`,
          [callbackPaymentIds],
        );
      }
      const archivedKots = await run<{ id: string }>(
        `UPDATE restaurant_kots
         SET archived_at = NOW(), updated_at = NOW()
         WHERE check_id = $1 AND archived_at IS NULL AND status IN ('served', 'cancelled')
         RETURNING id`,
        [existing.id]
      );
      await run(
        `UPDATE restaurant_checks
         SET cashier_id = $2, status = 'settled', settled_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [existing.id, shift.cashier_id]
      );
      await run(
        `INSERT INTO audit_log (company_id, property_id, outlet_id, actor_user_id, action_type, resource_type, resource_id, payload_after)
         VALUES ($1, $2, $3, $4, 'RESTAURANT_CHECK.SETTLE', 'restaurant_checks', $5, $6::jsonb)`,
        [auth.bundle.company.id, scope.propertyId, outletId, auth.userId, existing.id, JSON.stringify({ total, tenders: settlementTenders, cashier_id: shift.cashier_id, shift_id: shift.id, archived_kots: archivedKots.rows.length, callback_payment_ids: callbackPaymentIds })]
      );
      return { outcome: "settled" as const, check_id: existing.id, total, cashier_id: shift.cashier_id, cashier_name: shift.cashier_name };
    });

    if (result.outcome === "no_shift") return NextResponse.json({ success: false, message: "An open POS cashier shift is required before starting or settling a restaurant bill." }, { status: 409 });
    if (result.outcome === "invalid_scope") return NextResponse.json({ success: false, message: "The active shift does not belong to this outlet." }, { status: 409 });
    if (result.outcome === "not_owner") return NextResponse.json({ success: false, message: "Only the waiter assigned to this bill can change or settle it." }, { status: 403 });
    if (result.outcome === "pending_room_charge") return NextResponse.json({ success: false, message: "This bill is awaiting reception approval for a room charge. Ask reception to approve or reject the request before changing or settling it." }, { status: 409 });
    if (result.outcome === "different_shift") return NextResponse.json({ success: false, message: "This table has an open bill from another shift. Ask its waiter to settle it before starting a new bill." }, { status: 409 });
    if (result.outcome === "not_found") return NextResponse.json({ success: false, message: "Open restaurant bill not found." }, { status: 404 });
    if (result.outcome === "invalid_items") return NextResponse.json({ success: false, message: "One or more menu items are not active in this outlet." }, { status: 400 });
    if (result.outcome === "sent_items_locked") return NextResponse.json({ success: false, message: "Items already sent to the kitchen cannot be removed or changed." }, { status: 409 });
    if (result.outcome === "tender_mismatch") return NextResponse.json({ success: false, message: `Tender total must equal KSh ${result.total.toFixed(2)}.` }, { status: 400 });
    if (result.outcome === "callback_not_matched") return NextResponse.json({ success: false, message: "No successful, unapplied M-Pesa callback matches this bill and transaction code." }, { status: 409 });
    if (result.outcome === "callback_amount_mismatch") return NextResponse.json({ success: false, message: `The M-Pesa callback amount does not match the KSh ${result.total.toFixed(2)} bill.` }, { status: 409 });
    if (result.outcome === "insufficient_stock") {
      const warehouseName = result.warehouse === "bar" ? "Bar" : "Kitchen";
      return NextResponse.json({ success: false, message: `Not enough stock of ${result.itemName} in ${warehouseName} to settle this bill.` }, { status: 409 });
    }
    if (result.outcome === "already_settled") return NextResponse.json({ success: false, message: "This restaurant bill has already been settled." }, { status: 409 });
    if (result.outcome === "voided") return NextResponse.json({ success: true, message: "Unsent restaurant bill cancelled.", check_id: result.check_id });
    if (result.outcome === "settled") {
      let fiscalization: { status: string; message: string } = { status: "blocked", message: "The bill is paid but not yet eTIMS-signed." };
      try {
        fiscalization = await fiscalizeRestaurantBill(auth.userId, scope.propertyId, outletId, result.check_id);
      } catch (error) {
        console.error("Restaurant bill was paid, but its eTIMS submission could not be recorded.", error);
      }
      return NextResponse.json({
        success: true,
        message: `Bill settled for KSh ${result.total.toFixed(2)}. ${fiscalization.status === "submitted" ? "eTIMS receipt received." : `Paid but not yet eTIMS-signed: ${fiscalization.message}`}`,
        check_id: result.check_id,
        total: result.total,
        cashier_id: result.cashier_id,
        cashier_name: result.cashier_name,
        fiscalization,
      });
    }
    return NextResponse.json({
      success: true,
      message: "Bill saved.",
      check_id: result.check_id,
      bill_number: result.bill_number,
      total: result.total,
      shift_id: result.shift_id,
      cashier_id: result.cashier_id,
      cashier_name: result.cashier_name,
      waiter_id: result.waiter_id,
      waiter_name: result.waiter_name,
      kots: result.kots,
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      return NextResponse.json({ success: false, message: "Another waiter has already opened a bill for this table." }, { status: 409 });
    }
    console.error("Failed to update restaurant check.", error);
    return NextResponse.json({ success: false, message: "The restaurant bill was not changed." }, { status: 500 });
  }
}
