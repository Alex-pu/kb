import { NextResponse } from "next/server";
import { databaseReady, localApiAuthorized, query } from "@/lib/db/postgres";
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
  callback_secret?: string;
  callback_url?: string;
  timeout_url?: string;
}

export async function POST(request: Request) {
  if (!localApiAuthorized(request)) return NextResponse.json({ success: false, message: "LOCAL_API_TOKEN is required for LAN admin writes." }, { status: 401 });

  let body: DarajaConfigBody;
  try {
    body = await request.json() as DarajaConfigBody;
  } catch {
    return NextResponse.json({ success: false, message: "Configuration body must be valid JSON." }, { status: 400 });
  }

  if (!body.property_id || !body.short_code || !body.consumer_key || !body.consumer_secret || !body.passkey || !body.callback_secret || !body.callback_url) {
    return NextResponse.json({ success: false, message: "Property, shortcode, credentials, callback secret, and callback URL are required." }, { status: 400 });
  }
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });

  let encrypted: { consumer_key_encrypted: string; consumer_secret_encrypted: string; passkey_encrypted: string; callback_secret_encrypted: string };
  try {
    encrypted = {
      consumer_key_encrypted: encryptSecret(body.consumer_key),
      consumer_secret_encrypted: encryptSecret(body.consumer_secret),
      passkey_encrypted: encryptSecret(body.passkey),
      callback_secret_encrypted: encryptSecret(body.callback_secret),
    };
  } catch {
    return NextResponse.json({ success: false, message: "DARAJA_CONFIG_ENCRYPTION_KEY must be configured before saving secrets." }, { status: 503 });
  }

  await query(
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
        consumer_key_encrypted = EXCLUDED.consumer_key_encrypted,
        consumer_secret_encrypted = EXCLUDED.consumer_secret_encrypted,
        passkey_encrypted = EXCLUDED.passkey_encrypted,
        callback_secret_encrypted = EXCLUDED.callback_secret_encrypted,
        callback_url = EXCLUDED.callback_url,
        timeout_url = EXCLUDED.timeout_url,
        updated_at = NOW()
    `,
    [
      body.property_id,
      body.outlet_id || null,
      body.enabled ?? true,
      body.environment || "sandbox",
      body.short_code,
      encrypted.consumer_key_encrypted,
      encrypted.consumer_secret_encrypted,
      encrypted.passkey_encrypted,
      encrypted.callback_secret_encrypted,
      body.callback_url,
      body.timeout_url || null,
    ],
  );

  return NextResponse.json({ success: true, message: "Daraja configuration saved to local PostgreSQL." });
}
