import { NextResponse } from "next/server";
import { assertOutletAccess, getAuthContext, hasPermission } from "@/lib/auth/require-session";
import { databaseReady, withUserContext } from "@/lib/db/postgres";
import { encryptSecret } from "@/lib/supabase/secret-crypto";
import { DIGITAX_API_BASE_URL, DIGITAX_CALLBACK_URL } from "@/lib/etims/digitax";

export const runtime = "nodejs";

function validHttpsEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash &&
      !url.search && (url.hostname === "digitax.tech" || url.hostname.endsWith(".digitax.tech"));
  } catch {
    return false;
  }
}

function validCallbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash &&
      !url.search && url.hostname.includes(".") &&
      url.pathname.replace(/\/+$/, "").endsWith("/api/integrations/digitax/callback");
  } catch {
    return false;
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
  if (!hasPermission(auth.bundle, scope.propertyId, "settings:manage")) {
    return NextResponse.json({ success: false, message: "You do not have permission to manage integration settings." }, { status: 403 });
  }
  const result = await withUserContext(auth.userId, (run) => run<{
    enabled: boolean;
    api_base_url: string;
    callback_url: string;
    api_key_encrypted: string | null;
  }>(
    `SELECT enabled, api_base_url, callback_url, api_key_encrypted
     FROM digitax_configs WHERE property_id = $1 AND outlet_id = $2`,
    [scope.propertyId, outletId],
  ));
  const config = result.rows[0];
  return NextResponse.json({
    success: true,
    config: config ? {
      enabled: config.enabled,
      api_base_url: config.api_base_url,
      callback_url: config.callback_url,
      has_api_key: Boolean(config.api_key_encrypted),
    } : {
      enabled: false,
      api_base_url: DIGITAX_API_BASE_URL,
      callback_url: DIGITAX_CALLBACK_URL,
      has_api_key: false,
    },
  });
}

export async function PATCH(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });
  let body: { outlet_id?: string; enabled?: boolean; api_base_url?: string; callback_url?: string; api_key?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, message: "Request body must be valid JSON." }, { status: 400 });
  }
  if (!body.outlet_id || typeof body.enabled !== "boolean" ||
      typeof body.api_base_url !== "string" ||
      typeof body.callback_url !== "string" ||
      (body.api_key !== undefined && typeof body.api_key !== "string")) {
    return NextResponse.json({ success: false, message: "The DigiTax configuration is incomplete or invalid." }, { status: 400 });
  }
  const apiBaseUrl = body.api_base_url.trim().replace(/\/+$/, "");
  const callbackUrl = body.callback_url.trim().replace(/\/+$/, "");
  const apiKey = body.api_key?.trim() ?? "";
  if (apiBaseUrl.length > 500 || callbackUrl.length > 1000 || apiKey.length > 2000 ||
      !validHttpsEndpoint(apiBaseUrl) || !validCallbackUrl(callbackUrl)) {
    return NextResponse.json({ success: false, message: "Use a valid DigiTax HTTPS API base URL and a public HTTPS callback URL ending in /api/integrations/digitax/callback." }, { status: 400 });
  }
  const scope = assertOutletAccess(auth.bundle, body.outlet_id);
  if (!scope) return NextResponse.json({ success: false, message: "You are not assigned to this outlet." }, { status: 403 });
  if (!hasPermission(auth.bundle, scope.propertyId, "settings:manage")) {
    return NextResponse.json({ success: false, message: "You do not have permission to manage integration settings." }, { status: 403 });
  }
  const savedConfig = await withUserContext(auth.userId, (run) => run<{ has_api_key: boolean }>(
    `SELECT api_key_encrypted IS NOT NULL AS has_api_key
     FROM digitax_configs WHERE property_id = $1 AND outlet_id = $2`,
    [scope.propertyId, body.outlet_id],
  ));
  if (body.enabled && !apiKey && !savedConfig.rows[0]?.has_api_key) {
    return NextResponse.json({ success: false, message: "A DigiTax API key is required before enabling the integration." }, { status: 400 });
  }
  let encryptedApiKey: string | null = null;
  if (apiKey) {
    try {
      encryptedApiKey = encryptSecret(apiKey);
    } catch (error) {
      console.error("Unable to encrypt DigiTax API key.", error);
      return NextResponse.json({ success: false, message: "The server credential encryption key must be configured before saving the DigiTax API key." }, { status: 503 });
    }
  }
  try {
    await withUserContext(auth.userId, (run) => run(
      `INSERT INTO digitax_configs
         (property_id, outlet_id, enabled, api_base_url, callback_url, api_key_encrypted, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (property_id, outlet_id) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         api_base_url = EXCLUDED.api_base_url,
         callback_url = EXCLUDED.callback_url,
         api_key_encrypted = COALESCE(EXCLUDED.api_key_encrypted, digitax_configs.api_key_encrypted),
         updated_at = NOW()`,
      [scope.propertyId, body.outlet_id, body.enabled, apiBaseUrl, callbackUrl, encryptedApiKey],
    ));
    return NextResponse.json({ success: true, message: "DigiTax settings saved securely." });
  } catch (error) {
    console.error("Failed to save DigiTax configuration.", error);
    return NextResponse.json({ success: false, message: "The DigiTax configuration could not be saved." }, { status: 500 });
  }
}
