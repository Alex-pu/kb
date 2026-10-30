import { NextResponse } from "next/server";
import { assertOutletAccess, getAuthContext, hasPermission } from "@/lib/auth/require-session";
import { databaseReady, withUserContext } from "@/lib/db/postgres";
import { decryptSecret } from "@/lib/supabase/secret-crypto";

export const runtime = "nodejs";

interface DarajaConfigRow {
  environment: "sandbox" | "production";
  short_code: string;
  consumer_key_encrypted: string;
  consumer_secret_encrypted: string;
  callback_secret_encrypted: string;
  callback_url: string;
  enabled: boolean;
}

function callbackUrl(baseUrl: string, route: string, params: Record<string, string>) {
  const url = new URL(route, baseUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export async function POST(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });

  let body: { outlet_id?: string };
  try {
    body = await request.json() as { outlet_id?: string };
  } catch {
    return NextResponse.json({ success: false, message: "Request body must be valid JSON." }, { status: 400 });
  }
  if (!body.outlet_id) return NextResponse.json({ success: false, message: "outlet_id is required." }, { status: 400 });
  const scope = assertOutletAccess(auth.bundle, body.outlet_id);
  if (!scope) return NextResponse.json({ success: false, message: "You are not assigned to this outlet." }, { status: 403 });
  if (!hasPermission(auth.bundle, scope.propertyId, "settings:manage")) {
    return NextResponse.json({ success: false, message: "You do not have permission to manage integration settings." }, { status: 403 });
  }

  const result = await withUserContext(auth.userId, (run) => run<DarajaConfigRow>(
    `SELECT environment, short_code, consumer_key_encrypted, consumer_secret_encrypted,
            callback_secret_encrypted, callback_url, enabled
     FROM daraja_shop_configs
     WHERE property_id = $1 AND outlet_id = $2`,
    [scope.propertyId, body.outlet_id],
  ));
  const config = result.rows[0];
  if (!config || !config.enabled) {
    return NextResponse.json({ success: false, message: "Save and enable Daraja settings before registering C2B URLs." }, { status: 409 });
  }

  let consumerKey: string;
  let consumerSecret: string;
  let callbackSecret: string;
  try {
    consumerKey = decryptSecret(config.consumer_key_encrypted);
    consumerSecret = decryptSecret(config.consumer_secret_encrypted);
    callbackSecret = decryptSecret(config.callback_secret_encrypted);
  } catch (error) {
    console.error("Unable to decrypt Daraja credentials for C2B registration.", error);
    return NextResponse.json({ success: false, message: "Daraja credentials are not configured correctly." }, { status: 500 });
  }

  const baseUrl = config.environment === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";
  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64")}` },
    });
  } catch (error) {
    console.error("Daraja OAuth request failed during C2B registration.", error);
    return NextResponse.json({ success: false, message: "Could not reach Daraja to register C2B URLs." }, { status: 502 });
  }
  const tokenPayload = await tokenResponse.json().catch(() => ({})) as { access_token?: string; errorMessage?: string };
  if (!tokenResponse.ok || !tokenPayload.access_token) {
    return NextResponse.json({ success: false, message: tokenPayload.errorMessage || "Daraja access token request failed." }, { status: 502 });
  }

  const callbackBaseUrl = new URL(config.callback_url);
  const callbackParams = {
    property_id: scope.propertyId,
    outlet_id: body.outlet_id,
    secret: callbackSecret,
  };
  const registrationPayload = {
    ShortCode: config.short_code,
    ResponseType: "Completed",
    ConfirmationURL: callbackUrl(callbackBaseUrl.origin, callbackBaseUrl.pathname, callbackParams),
    ValidationURL: callbackUrl(callbackBaseUrl.origin, "/api/integrations/daraja/c2b/validation", callbackParams),
  };

  let registrationResponse: Response;
  try {
    registrationResponse = await fetch(`${baseUrl}/mpesa/c2b/v1/registerurl`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenPayload.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(registrationPayload),
    });
  } catch (error) {
    console.error("Daraja C2B URL registration request failed.", error);
    return NextResponse.json({ success: false, message: "Could not reach Daraja to register C2B URLs." }, { status: 502 });
  }
  const registrationResult = await registrationResponse.json().catch(() => ({})) as {
    ResponseCode?: string;
    ResponseDescription?: string;
    errorMessage?: string;
  };
  if (!registrationResponse.ok || registrationResult.ResponseCode !== "0") {
    return NextResponse.json({
      success: false,
      message: registrationResult.errorMessage || registrationResult.ResponseDescription || "Daraja rejected C2B URL registration.",
    }, { status: 502 });
  }

  return NextResponse.json({ success: true, message: "C2B confirmation and validation URLs were registered with Daraja." });
}
