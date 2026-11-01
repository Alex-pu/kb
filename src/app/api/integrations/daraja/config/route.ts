import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { assertOutletAccess, getAuthContext, hasPermission } from "@/lib/auth/require-session";
import { databaseReady, localApiAuthorized, query, withUserContext } from "@/lib/db/postgres";
import { encryptSecret } from "@/lib/supabase/secret-crypto";

export const runtime = "nodejs";

interface DarajaConfigBody {
  property_id?: string;
  outlet_id?: string;
  enabled?: boolean;
  environment?: "sandbox" | "production";
  short_code?: string;
  consumer_key?: string;
  consumer_secret?: string;
  passkey?: string;
  callback_url?: string;
  timeout_url?: string;
}

function validCallbackUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash &&
      url.pathname.replace(/\/+$/, "").endsWith("/api/integrations/daraja/callback");
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
    environment: "sandbox" | "production";
    short_code: string;
    consumer_key_encrypted: string;
    consumer_secret_encrypted: string;
    passkey_encrypted: string;
    callback_secret_encrypted: string;
    callback_url: string;
    timeout_url: string | null;
  }>(
    `SELECT enabled, environment, short_code, consumer_key_encrypted,
            consumer_secret_encrypted, passkey_encrypted, callback_secret_encrypted,
            callback_url, timeout_url
     FROM daraja_shop_configs
     WHERE property_id = $1 AND outlet_id = $2`,
    [scope.propertyId, outletId],
  ));
  const config = result.rows[0];
  return NextResponse.json({
    success: true,
    config: config ? {
      enabled: config.enabled,
      environment: config.environment,
      short_code: config.short_code,
      callback_url: config.callback_url,
      timeout_url: config.timeout_url ?? "",
      has_consumer_key: Boolean(config.consumer_key_encrypted),
      has_consumer_secret: Boolean(config.consumer_secret_encrypted),
      has_passkey: Boolean(config.passkey_encrypted),
      has_callback_secret: Boolean(config.callback_secret_encrypted),
    } : null,
  });
}

export async function POST(request: Request) {
  const localAuthorized = localApiAuthorized(request);
  const auth = localAuthorized ? null : await getAuthContext();
  if (!localAuthorized && !auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });

  let body: DarajaConfigBody;
  try {
    body = await request.json() as DarajaConfigBody;
  } catch {
    return NextResponse.json({ success: false, message: "Configuration body must be valid JSON." }, { status: 400 });
  }

  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  if (!body.property_id || !body.outlet_id || typeof body.enabled !== "boolean" ||
      (body.environment !== "sandbox" && body.environment !== "production") ||
      typeof body.short_code !== "string" || typeof body.callback_url !== "string") {
    return NextResponse.json({ success: false, message: "Property, outlet, gateway status, environment, shortcode, and callback URL are required." }, { status: 400 });
  }
  if (auth) {
    const scope = assertOutletAccess(auth.bundle, body.outlet_id);
    if (!scope || scope.propertyId !== body.property_id) {
      return NextResponse.json({ success: false, message: "You are not assigned to this property outlet." }, { status: 403 });
    }
    if (!hasPermission(auth.bundle, scope.propertyId, "settings:manage")) {
      return NextResponse.json({ success: false, message: "You do not have permission to manage integration settings." }, { status: 403 });
    }
  }

  const shortcode = body.short_code.trim();
  const callbackUrl = body.callback_url.trim();
  const timeoutUrl = body.timeout_url?.trim() || null;
  const consumerKey = body.consumer_key?.trim() || "";
  const consumerSecret = body.consumer_secret?.trim() || "";
  const passkey = body.passkey?.trim() || "";
  if (!/^[0-9]{5,10}$/.test(shortcode) || !validCallbackUrl(callbackUrl) ||
      callbackUrl.length > 1000 || (timeoutUrl && timeoutUrl.length > 1000) ||
      [consumerKey, consumerSecret, passkey].some((value) => value.length > 2000)) {
    return NextResponse.json({ success: false, message: "Enter a valid shortcode, credentials, and public HTTPS callback URL ending in /api/integrations/daraja/callback." }, { status: 400 });
  }

  const runQuery = <T extends import("pg").QueryResultRow>(sql: string, values?: unknown[]) =>
    auth
      ? withUserContext(auth.userId, (run) => run<T>(sql, values))
      : query<T>(sql, values);
  const existingResult = await runQuery<{
    consumer_key_encrypted: string;
    consumer_secret_encrypted: string;
    passkey_encrypted: string;
    callback_secret_encrypted: string;
  }>(
    `SELECT consumer_key_encrypted, consumer_secret_encrypted, passkey_encrypted, callback_secret_encrypted
     FROM daraja_shop_configs WHERE property_id = $1 AND outlet_id = $2`,
    [body.property_id, body.outlet_id],
  );
  const existing = existingResult.rows[0];
  if (!existing && (!consumerKey || !consumerSecret || !passkey)) {
    return NextResponse.json({ success: false, message: "Consumer key, consumer secret, and passkey are required for the initial Daraja setup." }, { status: 400 });
  }
  if (body.enabled && (!consumerKey && !existing?.consumer_key_encrypted ||
      !consumerSecret && !existing?.consumer_secret_encrypted ||
      !passkey && !existing?.passkey_encrypted)) {
    return NextResponse.json({ success: false, message: "Consumer key, consumer secret, and passkey are required before enabling Daraja." }, { status: 400 });
  }

  let encrypted: { consumer_key_encrypted: string; consumer_secret_encrypted: string; passkey_encrypted: string; callback_secret_encrypted: string };
  try {
    encrypted = {
      consumer_key_encrypted: consumerKey ? encryptSecret(consumerKey) : existing?.consumer_key_encrypted ?? "",
      consumer_secret_encrypted: consumerSecret ? encryptSecret(consumerSecret) : existing?.consumer_secret_encrypted ?? "",
      passkey_encrypted: passkey ? encryptSecret(passkey) : existing?.passkey_encrypted ?? "",
      callback_secret_encrypted: existing?.callback_secret_encrypted ?? encryptSecret(randomBytes(32).toString("hex")),
    };
  } catch (error) {
    console.error("Unable to encrypt Daraja credentials.", error);
    return NextResponse.json({ success: false, message: "DARAJA_CONFIG_ENCRYPTION_KEY must be configured before saving secrets." }, { status: 503 });
  }

  try {
    await runQuery(
    `
      INSERT INTO daraja_shop_configs (
        property_id, outlet_id, enabled, environment, short_code,
        consumer_key_encrypted, consumer_secret_encrypted, passkey_encrypted,
        callback_secret_encrypted, callback_url, timeout_url, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
      ON CONFLICT (property_id, outlet_id)
      DO UPDATE SET
        enabled = EXCLUDED.enabled,
        environment = EXCLUDED.environment,
        short_code = EXCLUDED.short_code,
        consumer_key_encrypted = COALESCE(NULLIF(EXCLUDED.consumer_key_encrypted, ''), daraja_shop_configs.consumer_key_encrypted),
        consumer_secret_encrypted = COALESCE(NULLIF(EXCLUDED.consumer_secret_encrypted, ''), daraja_shop_configs.consumer_secret_encrypted),
        passkey_encrypted = COALESCE(NULLIF(EXCLUDED.passkey_encrypted, ''), daraja_shop_configs.passkey_encrypted),
        callback_secret_encrypted = COALESCE(NULLIF(EXCLUDED.callback_secret_encrypted, ''), daraja_shop_configs.callback_secret_encrypted),
        callback_url = EXCLUDED.callback_url,
        timeout_url = EXCLUDED.timeout_url,
        updated_at = NOW()
    `,
    [
      body.property_id,
      body.outlet_id || null,
      body.enabled ?? true,
      body.environment,
      shortcode,
      consumerKey ? encrypted.consumer_key_encrypted : "",
      consumerSecret ? encrypted.consumer_secret_encrypted : "",
      passkey ? encrypted.passkey_encrypted : "",
      existing?.callback_secret_encrypted || encrypted.callback_secret_encrypted,
      callbackUrl,
      timeoutUrl,
    ],
  );
  } catch (error) {
    console.error("Failed to save Daraja configuration.", error);
    return NextResponse.json({ success: false, message: "The Daraja configuration could not be saved." }, { status: 500 });
  }

  return NextResponse.json({ success: true, message: "Daraja settings saved securely." });
}
