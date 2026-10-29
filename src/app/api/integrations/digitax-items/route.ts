import { NextResponse } from "next/server";
import { assertOutletAccess, getAuthContext, hasPermission } from "@/lib/auth/require-session";
import { databaseReady, withUserContext } from "@/lib/db/postgres";
import { decryptSecret } from "@/lib/supabase/secret-crypto";

export const runtime = "nodejs";

interface DigitaxItem {
  id: string;
  item_name: string;
  etims_item_code?: string;
  item_bar_code?: string;
  item_class_code: string | number;
  item_type_code?: string | number;
  origin_nation_code?: string;
  package_unit_code?: string;
  quantity_unit_code?: string;
  tax_type_code: string;
  default_unit_price?: number;
  active: boolean;
  status?: string;
  levies: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function GET(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const outletId = params.get("outlet_id");
  const after = params.get("after");
  if (!outletId || (after && after.length > 200)) {
    return NextResponse.json({ success: false, message: "A valid outlet_id and pagination cursor are required." }, { status: 400 });
  }
  const scope = assertOutletAccess(auth.bundle, outletId);
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
      [scope.propertyId, outletId],
    ));
    const config = configResult.rows[0];
    if (!config?.enabled || !config.api_key_encrypted) {
      return NextResponse.json({ success: false, message: "Enable DigiTax and save its API key in Property Settings before loading items." }, { status: 400 });
    }

    let apiBase: URL;
    try {
      apiBase = new URL(config.api_base_url.endsWith("/") ? config.api_base_url : `${config.api_base_url}/`);
    } catch {
      return NextResponse.json({ success: false, message: "The configured DigiTax API base URL is invalid." }, { status: 400 });
    }
    if (apiBase.protocol !== "https:" || !["digitax.tech", "api.digitax.tech"].includes(apiBase.hostname) &&
        !apiBase.hostname.endsWith(".digitax.tech")) {
      return NextResponse.json({ success: false, message: "The configured DigiTax API base URL is invalid." }, { status: 400 });
    }

    let apiKey: string;
    try {
      apiKey = decryptSecret(config.api_key_encrypted);
    } catch (error) {
      console.error("Unable to decrypt DigiTax API key for item lookup.", error);
      return NextResponse.json({ success: false, message: "The DigiTax API key could not be decrypted. Re-enter it in Property Settings." }, { status: 503 });
    }

    const apiUrl = new URL("items", apiBase);
    apiUrl.searchParams.set("page_size", "20");
    if (after) apiUrl.searchParams.set("after", after);
    const response = await fetch(apiUrl, {
      headers: { Accept: "application/json", "X-API-Key": apiKey },
      signal: AbortSignal.timeout(20000),
      cache: "no-store",
      redirect: "error",
    });
    const responseText = await response.text();
    let responseBody: unknown;
    try {
      responseBody = responseText ? JSON.parse(responseText) as unknown : null;
    } catch {
      responseBody = null;
    }
    if (!response.ok) {
      const providerMessage = isRecord(responseBody) && typeof responseBody.message === "string"
        ? ` DigiTax: ${responseBody.message.slice(0, 400)}`
        : "";
      return NextResponse.json(
        { success: false, message: `DigiTax item lookup failed (HTTP ${response.status}).${providerMessage}` },
        { status: 502 },
      );
    }

    const envelope = isRecord(responseBody) ? responseBody : null;
    const rawItems = envelope && Array.isArray(envelope.data) ? envelope.data : null;
    if (!rawItems) {
      return NextResponse.json({ success: false, message: "DigiTax returned an unrecognized item list response." }, { status: 502 });
    }
    const items: DigitaxItem[] = [];
    for (const rawItem of rawItems) {
      if (!isRecord(rawItem) || typeof rawItem.id !== "string" ||
          typeof rawItem.item_name !== "string" ||
          (typeof rawItem.item_class_code !== "string" && typeof rawItem.item_class_code !== "number") ||
          (typeof rawItem.item_type_code !== "string" && typeof rawItem.item_type_code !== "number") ||
          typeof rawItem.origin_nation_code !== "string" ||
          typeof rawItem.package_unit_code !== "string" ||
          typeof rawItem.quantity_unit_code !== "string" ||
          typeof rawItem.tax_type_code !== "string" ||
          typeof rawItem.default_unit_price !== "number" ||
          typeof rawItem.active !== "boolean") {
        return NextResponse.json({ success: false, message: "DigiTax returned an item with missing mapping details." }, { status: 502 });
      }
      items.push({
        id: rawItem.id,
        item_name: rawItem.item_name,
        item_class_code: rawItem.item_class_code,
        item_type_code: rawItem.item_type_code,
        origin_nation_code: rawItem.origin_nation_code,
        package_unit_code: rawItem.package_unit_code,
        quantity_unit_code: rawItem.quantity_unit_code,
        tax_type_code: rawItem.tax_type_code,
        default_unit_price: rawItem.default_unit_price,
        active: rawItem.active,
        ...(typeof rawItem.etims_item_code === "string" ? { etims_item_code: rawItem.etims_item_code } : {}),
        ...(typeof rawItem.item_bar_code === "string" ? { item_bar_code: rawItem.item_bar_code } : {}),
        ...(typeof rawItem.status === "string" ? { status: rawItem.status } : {}),
        levies: Array.isArray(rawItem.levies)
          ? rawItem.levies.filter((levy): levy is string => typeof levy === "string")
          : [],
      });
    }

    const pagination = envelope && isRecord(envelope.pagination) ? envelope.pagination : null;
    return NextResponse.json({
      success: true,
      items,
      next: pagination && typeof pagination.next === "string" ? pagination.next : null,
    });
  } catch (error) {
    console.error("Unable to load DigiTax items.", error);
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "DigiTax item lookup timed out. Try again."
      : "Could not reach DigiTax to load its items.";
    return NextResponse.json({ success: false, message }, { status: 502 });
  }
}
