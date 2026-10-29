import type { QueryResultRow } from "pg";
import { withUserContext } from "@/lib/db/postgres";
import { decryptSecret } from "@/lib/supabase/secret-crypto";
import { isDigitaxItemComplete } from "@/lib/etims/digitax-status";

export interface DigitaxCatalogItem {
  id: string;
  item_name: string;
  item_type_code: string;
  item_class_code: string;
  origin_nation_code: string;
  package_unit_code: string;
  quantity_unit_code: string;
  tax_type_code: string;
  default_unit_price: number;
  active: boolean;
  status?: string;
  provider_message?: string;
  etims_item_code?: string;
  item_bar_code?: string;
  is_stock_item?: boolean;
  stock_quantity?: number;
  levies: string[];
}

interface DigitaxConfigRow extends QueryResultRow {
  enabled: boolean;
  api_base_url: string;
  api_key_encrypted: string | null;
}

interface CatalogItemRow extends QueryResultRow {
  id: string;
  name: string;
  sku: string;
  price: string;
  stock_tracked: boolean;
  digitax_item_id: string | null;
  digitax_sync_status: string;
  digitax_item_type_code: string | null;
  etims_item_class_code: string | null;
  etims_tax_code: string | null;
  etims_origin_nation_code: string | null;
  etims_qty_unit_code: string | null;
  etims_pkg_unit_code: string | null;
  digitax_levies: string[];
  stock_quantity: string;
}

export interface DigitaxCredentials {
  apiBaseUrl: string;
  apiKey: string;
}

export type CatalogDigitaxSyncResult = {
  status: "synced" | "pending" | "failed";
  message: string;
  digitax_item_id?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringCode(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : null;
}

function parseDigitaxItem(value: unknown): DigitaxCatalogItem | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : null;
  const itemName = typeof value.item_name === "string" ? value.item_name : null;
  const itemTypeCode = stringCode(value.item_type_code);
  const itemClassCode = stringCode(value.item_class_code);
  const originNationCode = stringCode(value.origin_nation_code);
  const packageUnitCode = stringCode(value.package_unit_code);
  const quantityUnitCode = stringCode(value.quantity_unit_code);
  const taxTypeCode = stringCode(value.tax_type_code);
  if (!id || !itemName || !itemTypeCode || !itemClassCode || !originNationCode ||
      !packageUnitCode || !quantityUnitCode || !taxTypeCode ||
      typeof value.default_unit_price !== "number" || typeof value.active !== "boolean") {
    return null;
  }
  const levies = Array.isArray(value.levies)
    ? value.levies.filter((levy): levy is string => typeof levy === "string")
    : [];
  return {
    id,
    item_name: itemName,
    item_type_code: itemTypeCode,
    item_class_code: itemClassCode,
    origin_nation_code: originNationCode,
    package_unit_code: packageUnitCode,
    quantity_unit_code: quantityUnitCode,
    tax_type_code: taxTypeCode,
    default_unit_price: value.default_unit_price,
    active: value.active,
    ...(typeof value.status === "string" ? { status: value.status.toUpperCase() } : {}),
    ...(["kra_response_message", "sync_error", "message"].some((key) => typeof value[key] === "string")
      ? { provider_message: String(value.kra_response_message ?? value.sync_error ?? value.message).slice(0, 500) }
      : {}),
    ...(typeof value.etims_item_code === "string" ? { etims_item_code: value.etims_item_code } : {}),
    ...(typeof value.item_bar_code === "string" && value.item_bar_code.trim()
      ? { item_bar_code: value.item_bar_code.trim() }
      : {}),
    ...(typeof value.is_stock_item === "boolean" ? { is_stock_item: value.is_stock_item } : {}),
    ...(typeof value.stock_quantity === "number" ? { stock_quantity: value.stock_quantity } : {}),
    levies,
  };
}

export async function getDigitaxCredentials(
  userId: string,
  propertyId: string,
  outletId: string,
): Promise<DigitaxCredentials> {
  const result = await withUserContext(userId, (run) => run<DigitaxConfigRow>(
    `SELECT enabled, api_base_url, api_key_encrypted
     FROM digitax_configs WHERE property_id = $1 AND outlet_id = $2`,
    [propertyId, outletId],
  ));
  const config = result.rows[0];
  if (!config?.enabled || !config.api_key_encrypted) {
    throw new Error("Enable DigiTax and save its API key in Property Settings before adding sale items.");
  }
  let base: URL;
  try {
    base = new URL(config.api_base_url.endsWith("/") ? config.api_base_url : `${config.api_base_url}/`);
  } catch {
    throw new Error("The configured DigiTax API base URL is invalid.");
  }
  if (base.protocol !== "https:" || !base.hostname.endsWith("digitax.tech") ||
      (base.hostname !== "digitax.tech" && !base.hostname.endsWith(".digitax.tech")) ||
      base.username || base.password || base.search || base.hash) {
    throw new Error("The configured DigiTax API base URL is invalid.");
  }
  let apiKey: string;
  try {
    apiKey = decryptSecret(config.api_key_encrypted);
  } catch (error) {
    console.error("Unable to decrypt DigiTax API key for catalog registration.", error);
    throw new Error("The DigiTax API key could not be decrypted. Re-enter it in Property Settings.");
  }
  return { apiBaseUrl: base.toString(), apiKey };
}

async function digitaxRequest(
  credentials: DigitaxCredentials,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const base = credentials.apiBaseUrl.endsWith("/") ? credentials.apiBaseUrl : `${credentials.apiBaseUrl}/`;
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      Accept: "application/json",
      "X-API-Key": credentials.apiKey,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
    cache: "no-store",
    redirect: "error",
  });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) as unknown : null;
  } catch {
    throw new Error("DigiTax returned an invalid response.");
  }
  if (!response.ok) {
    const message = isRecord(payload) && typeof payload.message === "string"
      ? ` ${payload.message.slice(0, 400)}`
      : "";
    throw new Error(`DigiTax item request failed (HTTP ${response.status}).${message}`);
  }
  return payload;
}

export async function getDigitaxItemTemplate(
  credentials: DigitaxCredentials,
  itemId: string,
): Promise<DigitaxCatalogItem> {
  const item = await fetchDigitaxItem(credentials, itemId);
  if (!item.active || (item.status && !isDigitaxItemComplete(item.status)) ||
      (item.item_type_code !== "2" && item.item_type_code !== "3") ||
      !/^[ABCDE]$/.test(item.tax_type_code)) {
    throw new Error("Select an active, completed DigiTax finished product or service with a supported tax code.");
  }
  return item;
}

async function fetchDigitaxItem(
  credentials: DigitaxCredentials,
  itemId: string,
): Promise<DigitaxCatalogItem> {
  const payload = await digitaxRequest(credentials, "GET", `items/${encodeURIComponent(itemId)}`);
  const value = isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
  const item = parseDigitaxItem(value);
  if (!item) throw new Error("DigiTax returned incomplete item classification details.");
  return item;
}

async function findByBarcode(
  credentials: DigitaxCredentials,
  barcode: string,
): Promise<DigitaxCatalogItem | null> {
  const base = credentials.apiBaseUrl.endsWith("/") ? credentials.apiBaseUrl : `${credentials.apiBaseUrl}/`;
  const cursors = new Set<string>();
  let after: string | null = null;
  let match: DigitaxCatalogItem | null = null;
  for (let page = 0; page < 100; page += 1) {
    const url = new URL("items", base);
    url.searchParams.set("page_size", "20");
    if (after) url.searchParams.set("after", after);
    const payload = await digitaxRequest(credentials, "GET", url.toString());
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new Error("DigiTax returned an unrecognized item list response during retry.");
    }
    for (const raw of payload.data) {
      if (isRecord(raw) && typeof raw.item_bar_code === "string" &&
          raw.item_bar_code.trim().toUpperCase() === barcode.toUpperCase()) {
        const existing = parseDigitaxItem(raw);
        if (!existing) throw new Error("DigiTax already has this SKU barcode but returned incomplete item details. Review the item in DigiTax before retrying.");
        if (match) throw new Error("More than one DigiTax item uses this SKU barcode. Review the duplicate items in DigiTax before retrying.");
        match = existing;
      }
    }
    const pagination = isRecord(payload.pagination) ? payload.pagination : null;
    const next = pagination && typeof pagination.next === "string" && pagination.next ? pagination.next : null;
    if (!next) return match;
    if (cursors.has(next)) throw new Error("DigiTax repeated an item page cursor during retry.");
    cursors.add(next);
    after = next;
  }
  throw new Error("DigiTax catalog exceeds 2,000 items; could not safely check for an existing barcode.");
}

function providerStatus(item: DigitaxCatalogItem): CatalogDigitaxSyncResult["status"] {
  if (!item.active || item.status === "FAILED") return "failed";
  return isDigitaxItemComplete(item.status) ? "synced" : "pending";
}

export async function syncCatalogItemToDigitax(
  userId: string,
  propertyId: string,
  outletId: string,
  itemId: string,
  reconcileBeforeCreate: boolean,
): Promise<CatalogDigitaxSyncResult> {
  const claim = await withUserContext(userId, (run) => run<CatalogItemRow>(
    `UPDATE items i SET digitax_sync_status = 'sending', digitax_sync_error = NULL, updated_at = NOW()
     WHERE i.id = $1 AND i.property_id = $2 AND i.digitax_item_type_code IN ('2', '3')
       AND EXISTS (SELECT 1 FROM item_outlets io WHERE io.item_id = i.id AND io.outlet_id = $3)
       AND (i.digitax_sync_status <> 'sending' OR i.updated_at < NOW() - INTERVAL '2 minutes')
     RETURNING i.id, i.name, i.sku, i.price, i.stock_tracked, i.digitax_item_id,
       i.digitax_sync_status, i.digitax_item_type_code, i.etims_item_class_code,
       i.etims_tax_code, i.etims_origin_nation_code, i.etims_qty_unit_code,
       i.etims_pkg_unit_code, i.digitax_levies,
       COALESCE((SELECT SUM(sl.quantity) FROM stock_levels sl
         WHERE sl.item_id = i.id AND sl.outlet_id = $3), 0)::text AS stock_quantity`,
    [itemId, propertyId, outletId],
  ));
  const item = claim.rows[0];
  if (!item) {
    const exists = await withUserContext(userId, (run) => run<{ id: string }>(
      `SELECT id FROM items i WHERE i.id = $1 AND i.property_id = $2
       AND EXISTS (SELECT 1 FROM item_outlets io WHERE io.item_id = i.id AND io.outlet_id = $3)`,
      [itemId, propertyId, outletId],
    ));
    if (!exists.rows[0]) return { status: "failed", message: "Catalog item was not found in this outlet." };
    return { status: "pending", message: "DigiTax registration is already in progress or the item needs a DigiTax profile." };
  }

  let credentials: DigitaxCredentials;
  try {
    credentials = await getDigitaxCredentials(userId, propertyId, outletId);
    if (!item.etims_item_class_code || !item.etims_tax_code || !item.etims_origin_nation_code ||
        !item.etims_qty_unit_code || !item.etims_pkg_unit_code || !item.digitax_item_type_code) {
      throw new Error("This catalog item has no DigiTax classification profile. Add it with a DigiTax profile first.");
    }

    let remote: DigitaxCatalogItem | null = null;
    if (item.digitax_item_id) {
      remote = await fetchDigitaxItem(credentials, item.digitax_item_id);
    } else if (reconcileBeforeCreate) {
      remote = await findByBarcode(credentials, item.sku);
    }

    if (remote && (
      remote.item_bar_code?.toUpperCase() !== item.sku.toUpperCase() ||
      remote.item_type_code !== item.digitax_item_type_code ||
      remote.item_class_code !== item.etims_item_class_code ||
      remote.tax_type_code !== item.etims_tax_code ||
      remote.origin_nation_code !== item.etims_origin_nation_code ||
      remote.package_unit_code !== item.etims_pkg_unit_code ||
      remote.quantity_unit_code !== item.etims_qty_unit_code
    )) {
      throw new Error("A DigiTax item already uses this SKU barcode but its tax/classification details differ. Review it in DigiTax before retrying.");
    }

    if (!remote) {
      const payload: Record<string, unknown> = {
        item_class_code: item.etims_item_class_code,
        item_type_code: item.digitax_item_type_code,
        item_name: item.name,
        origin_nation_code: item.etims_origin_nation_code,
        package_unit_code: item.etims_pkg_unit_code,
        quantity_unit_code: item.etims_qty_unit_code,
        tax_type_code: item.etims_tax_code,
        default_unit_price: Number(item.price),
        item_bar_code: item.sku,
        levies: item.digitax_levies,
      };
      if (item.digitax_item_type_code === "2") payload.stock_quantity = Number(item.stock_quantity);
      const response = await digitaxRequest(credentials, "POST", "items", payload);
      const value = isRecord(response) && isRecord(response.data) ? response.data : response;
      remote = parseDigitaxItem(value);
      if (!remote) throw new Error("DigiTax accepted the item request but returned no usable item status. Retry to reconcile by SKU.");
    }

    const status = providerStatus(remote);
    const message = status === "synced"
      ? "Registered and synchronized with DigiTax."
      : status === "failed"
        ? !remote.active
          ? "The DigiTax item is inactive. Activate it in DigiTax before retrying."
          : `DigiTax registration failed: ${remote.provider_message ?? "Review the item in DigiTax before retrying."}`
        : "DigiTax accepted the item; eTIMS synchronization is pending.";
    await withUserContext(userId, (run) => run(
      `UPDATE items SET digitax_item_id = $3, digitax_sync_status = $4, digitax_sync_error = $5,
         etims_item_code = $6, updated_at = NOW()
       WHERE id = $1 AND property_id = $2`,
      [itemId, propertyId, remote?.id ?? null, status, status === "synced" ? null : message, item.sku],
    ));
    return { status, message, digitax_item_id: remote.id };
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "DigiTax item registration timed out. Retry to check the SKU before creating another remote item."
      : error instanceof Error ? error.message : "Could not register the item with DigiTax.";
    await withUserContext(userId, (run) => run(
      `UPDATE items SET digitax_sync_status = 'failed', digitax_sync_error = $3, updated_at = NOW()
       WHERE id = $1 AND property_id = $2`,
      [itemId, propertyId, message.slice(0, 1000)],
    ));
    console.error("Unable to register catalog item with DigiTax.", error);
    return { status: "failed", message };
  }
}
