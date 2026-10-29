import { NextResponse } from "next/server";
import { assertOutletAccess, getAuthContext, hasPermission } from "@/lib/auth/require-session";
import { databaseReady, withUserContext } from "@/lib/db/postgres";
import { decryptSecret } from "@/lib/supabase/secret-crypto";
import { isDigitaxItemComplete } from "@/lib/etims/digitax-status";

export const runtime = "nodejs";

interface DigitaxItem {
  id: string;
  item_name: string;
  item_type_code: string;
  item_class_code: string;
  tax_type_code: string;
  default_unit_price: number;
  quantity_unit_code: string;
  package_unit_code: string;
  origin_nation_code: string;
  active: boolean;
  status?: string;
  item_bar_code?: string;
  levies: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadDigitaxItems(apiBaseUrl: string, apiKey: string): Promise<DigitaxItem[]> {
  const base = new URL(apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`);
  if (base.protocol !== "https:" || !base.hostname.endsWith("digitax.tech") ||
      (base.hostname !== "digitax.tech" && !base.hostname.endsWith(".digitax.tech")) ||
      base.username || base.password || base.search || base.hash) {
    throw new Error("The configured DigiTax API base URL is invalid.");
  }

  const items: DigitaxItem[] = [];
  const seenCursors = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const url = new URL("items", base);
    url.searchParams.set("page_size", "20");
    if (after) url.searchParams.set("after", after);
    const response = await fetch(url, {
      headers: { Accept: "application/json", "X-API-Key": apiKey },
      signal: AbortSignal.timeout(20000),
      cache: "no-store",
      redirect: "error",
    });
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) as unknown : null;
    } catch {
      throw new Error(`DigiTax returned invalid JSON while loading page ${page + 1}.`);
    }
    if (!response.ok) {
      const message = isRecord(payload) && typeof payload.message === "string" ? ` ${payload.message.slice(0, 400)}` : "";
      throw new Error(`DigiTax item lookup failed (HTTP ${response.status}).${message}`);
    }
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new Error("DigiTax returned an unrecognized item list response.");
    }
    for (const raw of payload.data) {
      if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.item_name !== "string" ||
          (typeof raw.item_class_code !== "string" && typeof raw.item_class_code !== "number") ||
          typeof raw.tax_type_code !== "string" || typeof raw.default_unit_price !== "number" ||
          typeof raw.quantity_unit_code !== "string" || typeof raw.package_unit_code !== "string" ||
          typeof raw.origin_nation_code !== "string" ||
          (typeof raw.item_type_code !== "string" && typeof raw.item_type_code !== "number") ||
          typeof raw.active !== "boolean") {
        throw new Error("DigiTax returned an item with incomplete product details.");
      }
      items.push({
        id: raw.id,
        item_name: raw.item_name,
        item_type_code: String(raw.item_type_code),
        item_class_code: String(raw.item_class_code),
        tax_type_code: raw.tax_type_code,
        default_unit_price: raw.default_unit_price,
        quantity_unit_code: raw.quantity_unit_code,
        package_unit_code: raw.package_unit_code,
        origin_nation_code: raw.origin_nation_code,
        active: raw.active,
        ...(typeof raw.status === "string" ? { status: raw.status } : {}),
        ...(typeof raw.item_bar_code === "string" && raw.item_bar_code.trim()
          ? { item_bar_code: raw.item_bar_code.trim() } : {}),
        levies: Array.isArray(raw.levies)
          ? raw.levies.filter((levy): levy is string => typeof levy === "string")
          : [],
      });
    }
    const pagination = isRecord(payload.pagination) ? payload.pagination : null;
    const next = pagination && typeof pagination.next === "string" && pagination.next ? pagination.next : null;
    if (!next) return items;
    if (seenCursors.has(next)) throw new Error("DigiTax repeated an item page cursor. No products were imported.");
    seenCursors.add(next);
    after = next;
  }
  throw new Error("DigiTax has more than 2,000 items. No products were imported; contact support to sync a larger catalog.");
}

function allocateSkuCounter(row: { allocated_value: string }): string {
  return `SKU-${row.allocated_value.padStart(6, "0")}`;
}

export async function POST(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, message: "Request body must be valid JSON." }, { status: 400 });
  }
  if (!isRecord(body) || typeof body.outlet_id !== "string") {
    return NextResponse.json({ success: false, message: "outlet_id is required." }, { status: 400 });
  }
  const scope = assertOutletAccess(auth.bundle, body.outlet_id);
  if (!scope) return NextResponse.json({ success: false, message: "You are not assigned to this outlet." }, { status: 403 });
  if (!hasPermission(auth.bundle, scope.propertyId, "catalog:manage")) {
    return NextResponse.json({ success: false, message: "You do not have permission to manage catalog items." }, { status: 403 });
  }

  try {
    const configResult = await withUserContext(auth.userId, (run) => run<{
      enabled: boolean;
      api_base_url: string;
      api_key_encrypted: string | null;
    }>(
      `SELECT enabled, api_base_url, api_key_encrypted
       FROM digitax_configs WHERE property_id = $1 AND outlet_id = $2`,
      [scope.propertyId, body.outlet_id],
    ));
    const config = configResult.rows[0];
    if (!config?.enabled || !config.api_key_encrypted) {
      return NextResponse.json({ success: false, message: "Enable DigiTax and save its API key in Property Settings before syncing." }, { status: 400 });
    }
    let apiKey: string;
    try {
      apiKey = decryptSecret(config.api_key_encrypted);
    } catch (error) {
      console.error("Unable to decrypt DigiTax API key for catalog sync.", error);
      return NextResponse.json({ success: false, message: "The DigiTax API key could not be decrypted. Re-enter it in Property Settings." }, { status: 503 });
    }

    const remoteItems = await loadDigitaxItems(config.api_base_url, apiKey);
    const result = await withUserContext(auth.userId, async (run) => {
      const skippedByReason = {
        inactive: 0,
        syncing_or_failed: 0,
        unsupported_type: 0,
        invalid_details: 0,
        missing_barcode: 0,
        ambiguous_barcode: 0,
      };
      const skippedItems: Array<{ id: string; name: string; reason: string }> = [];
      const skip = (item: DigitaxItem, key: keyof typeof skippedByReason, reason: string) => {
        skippedByReason[key] += 1;
        if (skippedItems.length < 50) skippedItems.push({ id: item.id, name: item.item_name, reason });
      };
      const eligibleItems = remoteItems.filter((item) =>
        item.active && (!item.status || isDigitaxItemComplete(item.status)) &&
        item.item_type_code === "2" &&
        /^[ABCDE]$/.test(item.tax_type_code) &&
        item.item_class_code.trim().length > 0 &&
        Number.isFinite(item.default_unit_price) && item.default_unit_price >= 0 &&
        item.item_name.trim().length > 0 &&
        item.item_name.trim().length <= 255,
      );
      if (eligibleItems.length > 500) {
        return { error: "More than 500 eligible DigiTax items were found. No products were imported in this run." };
      }

      const categoryResult = await run<{ id: string }>(
        `INSERT INTO categories (property_id, name) VALUES ($1, 'grocery')
         ON CONFLICT (property_id, name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [scope.propertyId],
      );
      const categoryId = categoryResult.rows[0]?.id ?? null;
      if (!categoryId) throw new Error("The catalog category could not be prepared.");

      const existing = await run<{ id: string; barcode: string | null }>(
        `SELECT i.id, i.barcode
         FROM items i
         JOIN item_outlets io ON io.item_id = i.id AND io.outlet_id = $2
         WHERE i.property_id = $1 AND i.item_type IN ('retail', 'menu') AND i.barcode IS NOT NULL`,
        [scope.propertyId, body.outlet_id],
      );
      const localByBarcode = new Map<string, string[]>();
      for (const item of existing.rows) {
        const key = item.barcode?.trim().toUpperCase();
        if (!key) continue;
        const rows = localByBarcode.get(key) ?? [];
        rows.push(item.id);
        localByBarcode.set(key, rows);
      }
      const remoteBarcodeCounts = new Map<string, number>();
      for (const item of eligibleItems) {
        const key = item.item_bar_code?.trim().toUpperCase();
        if (key) remoteBarcodeCounts.set(key, (remoteBarcodeCounts.get(key) ?? 0) + 1);
      }

      let created = 0;
      let mapped = 0;
      for (const remote of remoteItems) {
        if (!remote.active) {
          skip(remote, "inactive", "Inactive in DigiTax.");
          continue;
        }
        if (remote.status && !isDigitaxItemComplete(remote.status)) {
          skip(remote, "syncing_or_failed", `DigiTax status is ${remote.status}.`);
          continue;
        }
        if (remote.item_type_code !== "2") {
          skip(remote, "unsupported_type", "Only finished products can be imported as sale items.");
          continue;
        }
        if (!/^[ABCDE]$/.test(remote.tax_type_code) || !remote.item_class_code.trim() ||
            !Number.isFinite(remote.default_unit_price) || remote.default_unit_price < 0 ||
            !remote.item_name.trim() || remote.item_name.trim().length > 255) {
          skip(remote, "invalid_details", "Tax, class, name, or price is invalid or missing.");
          continue;
        }
        const barcode = remote.item_bar_code?.trim() ?? "";
        if (!barcode) {
          skip(remote, "missing_barcode", "Add a unique barcode in DigiTax before importing this product.");
          continue;
        }
        const barcodeKey = barcode.toUpperCase();
        const matches = barcodeKey ? localByBarcode.get(barcodeKey) ?? [] : [];
        if (barcodeKey && (matches.length > 1 || remoteBarcodeCounts.get(barcodeKey) !== 1)) {
          skip(remote, "ambiguous_barcode", "This barcode matches multiple local or DigiTax items.");
          continue;
        }

        if (matches.length === 1) {
          await run(
            `UPDATE items SET etims_item_code = $3, etims_tax_code = $4,
               etims_item_class_code = $5, digitax_item_id = $6, digitax_sync_status = 'synced',
               digitax_sync_error = NULL, digitax_item_type_code = $7,
               etims_origin_nation_code = $8, etims_qty_unit_code = $9,
               etims_pkg_unit_code = $10, digitax_levies = $11, updated_at = NOW()
             WHERE id = $1 AND property_id = $2`,
            [matches[0], scope.propertyId, barcode, remote.tax_type_code, remote.item_class_code,
              remote.id, remote.item_type_code, remote.origin_nation_code, remote.quantity_unit_code,
              remote.package_unit_code, remote.levies],
          );
          mapped += 1;
          continue;
        }

        let sku: string | null = null;
        for (let attempt = 0; attempt < 10 && !sku; attempt += 1) {
          const counter = await run<{ allocated_value: string }>(
            `INSERT INTO catalog_sku_counters (property_id, next_value)
             VALUES ($1, 2)
             ON CONFLICT (property_id)
             DO UPDATE SET next_value = catalog_sku_counters.next_value + 1
             RETURNING (next_value - 1)::text AS allocated_value`,
            [scope.propertyId],
          );
          const candidate = allocateSkuCounter(counter.rows[0]);
          const duplicate = await run<{ id: string }>(
            `SELECT id FROM items WHERE property_id = $1 AND sku = $2 LIMIT 1`,
            [scope.propertyId, candidate],
          );
          if (!duplicate.rows[0]) sku = candidate;
        }
        if (!sku) throw new Error("A unique KoreBench SKU could not be allocated.");

        const createdItem = await run<{ id: string }>(
          `INSERT INTO items
             (property_id, outlet_id, category_id, name, sku, barcode, item_type, price,
              stock_tracked, reorder_level, prep_station, unit, etims_item_code,
              etims_tax_code, etims_item_class_code, digitax_item_id, digitax_sync_status,
              digitax_item_type_code, etims_origin_nation_code, etims_qty_unit_code,
              etims_pkg_unit_code, digitax_levies)
           VALUES ($1, $2, $3, $4, $5, $6, 'retail', $7, TRUE, 0, 'kitchen', $8, $9, $10, $11,
              $12, 'synced', $13, $14, $15, $16, $17)
           RETURNING id`,
          [scope.propertyId, body.outlet_id, categoryId, remote.item_name.trim(), sku,
            barcode, remote.default_unit_price, remote.quantity_unit_code.slice(0, 40) || "each",
            barcode, remote.tax_type_code, remote.item_class_code, remote.id, remote.item_type_code,
            remote.origin_nation_code, remote.quantity_unit_code, remote.package_unit_code, remote.levies],
        );
        const itemId = createdItem.rows[0]?.id;
        if (!itemId) throw new Error("A DigiTax item could not be added to the catalog.");
        await run(
          `INSERT INTO item_outlets (property_id, outlet_id, item_id) VALUES ($1, $2, $3)`,
          [scope.propertyId, body.outlet_id, itemId],
        );
        await run(
          `INSERT INTO central_stock_levels (property_id, item_id, quantity) VALUES ($1, $2, 0)`,
          [scope.propertyId, itemId],
        );
        await run(
          `INSERT INTO stock_levels (property_id, outlet_id, item_id, warehouse, quantity)
           VALUES ($1, $2, $3, 'kitchen', 0), ($1, $2, $3, 'bar', 0)
           ON CONFLICT (outlet_id, item_id, warehouse) DO NOTHING`,
          [scope.propertyId, body.outlet_id, itemId],
        );
        localByBarcode.set(barcode.toUpperCase(), [itemId]);
        created += 1;
      }
      return {
        created,
        mapped,
        skipped: Object.values(skippedByReason).reduce((sum, count) => sum + count, 0),
        skipped_by_reason: skippedByReason,
        skipped_items: skippedItems,
        additional_skipped_items: Math.max(0, Object.values(skippedByReason).reduce((sum, count) => sum + count, 0) - skippedItems.length),
      };
    });

    if ("error" in result) return NextResponse.json({ success: false, message: result.error }, { status: 400 });
    return NextResponse.json({
      success: true,
      ...result,
      message: `DigiTax import complete: ${result.created} new product(s) added, ${result.mapped} exact barcode match(es) mapped. Skipped: ${result.skipped_by_reason.missing_barcode} without a DigiTax barcode, ${result.skipped_by_reason.syncing_or_failed} not fully synced, ${result.skipped_by_reason.unsupported_type} non-finished item(s), ${result.skipped_by_reason.ambiguous_barcode} ambiguous barcode(s), ${result.skipped_by_reason.invalid_details} invalid item(s), and ${result.skipped_by_reason.inactive} inactive item(s).${result.additional_skipped_items ? ` ${result.additional_skipped_items} more skip reason(s) were omitted from the item list.` : ""}`,
    });
  } catch (error) {
    console.error("Unable to sync DigiTax items into the catalog.", error);
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "DigiTax item sync timed out. No catalog changes were committed."
      : error instanceof Error ? error.message : "Could not sync DigiTax items into the catalog.";
    return NextResponse.json({ success: false, message }, { status: 502 });
  }
}
