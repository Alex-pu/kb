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
  passkey_encrypted: string;
  callback_secret_encrypted: string;
  callback_url: string;
}

function normalizePhone(phone: string) {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("254") && digits.length === 12) return digits;
  if (digits.startsWith("0") && digits.length === 10) return `254${digits.slice(1)}`;
  if (digits.length === 9 && (digits.startsWith("7") || digits.startsWith("1"))) return `254${digits}`;
  return "";
}

function timestamp() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export async function POST(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });

  let body: { outlet_id?: string; payer_phone?: string; amount?: number };
  try {
    body = await request.json() as { outlet_id?: string; payer_phone?: string; amount?: number };
  } catch {
    return NextResponse.json({ success: false, message: "Request body must be valid JSON." }, { status: 400 });
  }
  if (!body.outlet_id || typeof body.payer_phone !== "string") {
    return NextResponse.json({ success: false, message: "outlet_id and payer_phone are required." }, { status: 400 });
  }
  const scope = assertOutletAccess(auth.bundle, body.outlet_id);
  if (!scope) return NextResponse.json({ success: false, message: "You are not assigned to this outlet." }, { status: 403 });
  if (!hasPermission(auth.bundle, scope.propertyId, "settings:manage")) {
    return NextResponse.json({ success: false, message: "You do not have permission to test Daraja settings." }, { status: 403 });
  }

  const amount = Number(body.amount);
  const phone = normalizePhone(body.payer_phone);
  if (!phone || !Number.isInteger(amount) || amount < 1 || amount > 150000) {
    return NextResponse.json({ success: false, message: "Enter a valid Kenyan phone number and a whole-number amount from KSh 1 to KSh 150,000." }, { status: 400 });
  }

  const result = await withUserContext(auth.userId, (run) => run<DarajaConfigRow>(
    `SELECT environment, short_code, consumer_key_encrypted, consumer_secret_encrypted,
            passkey_encrypted, callback_secret_encrypted, callback_url
     FROM daraja_shop_configs
     WHERE property_id = $1 AND outlet_id = $2 AND enabled = TRUE`,
    [scope.propertyId, body.outlet_id],
  ));
  const config = result.rows[0];
  if (!config) {
    return NextResponse.json({ success: false, message: "Save and enable Daraja settings for this outlet before testing." }, { status: 409 });
  }

  let consumerKey: string;
  let consumerSecret: string;
  let passkey: string;
  let callbackSecret: string;
  try {
    consumerKey = decryptSecret(config.consumer_key_encrypted);
    consumerSecret = decryptSecret(config.consumer_secret_encrypted);
    passkey = decryptSecret(config.passkey_encrypted);
    callbackSecret = decryptSecret(config.callback_secret_encrypted);
  } catch (error) {
    console.error("Unable to decrypt Daraja credentials for test prompt.", error);
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
    console.error("Daraja OAuth request failed during endpoint test.", error);
    return NextResponse.json({ success: false, message: "Could not reach Daraja to test the credentials." }, { status: 502 });
  }
  const tokenPayload = await tokenResponse.json().catch(() => ({})) as { access_token?: string; errorMessage?: string };
  if (!tokenResponse.ok || !tokenPayload.access_token) {
    return NextResponse.json({ success: false, message: tokenPayload.errorMessage || "Daraja rejected the credentials." }, { status: 502 });
  }

  const requestTimestamp = timestamp();
  const callbackUrl = new URL(config.callback_url);
  callbackUrl.searchParams.set("property_id", scope.propertyId);
  callbackUrl.searchParams.set("outlet_id", body.outlet_id);
  callbackUrl.searchParams.set("secret", callbackSecret);
  const stkPayload = {
    BusinessShortCode: config.short_code,
    Password: Buffer.from(`${config.short_code}${passkey}${requestTimestamp}`).toString("base64"),
    Timestamp: requestTimestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: amount,
    PartyA: phone,
    PartyB: config.short_code,
    PhoneNumber: phone,
    CallBackURL: callbackUrl.toString(),
    AccountReference: "ENDPOINTTEST",
    TransactionDesc: "Daraja endpoint test",
  };

  let stkResponse: Response;
  try {
    stkResponse = await fetch(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenPayload.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(stkPayload),
    });
  } catch (error) {
    console.error("Daraja STK request failed during endpoint test.", error);
    return NextResponse.json({ success: false, message: "Could not reach Daraja to send the test prompt." }, { status: 502 });
  }
  const stkResult = await stkResponse.json().catch(() => ({})) as {
    CheckoutRequestID?: string;
    ResponseCode?: string;
    ResponseDescription?: string;
    errorMessage?: string;
  };
  if (!stkResponse.ok || stkResult.ResponseCode !== "0" || !stkResult.CheckoutRequestID) {
    return NextResponse.json({
      success: false,
      message: stkResult.errorMessage || stkResult.ResponseDescription || "Daraja did not accept the test prompt.",
    }, { status: 502 });
  }

  try {
    await withUserContext(auth.userId, (run) => run(
      `INSERT INTO daraja_payments (
         property_id, outlet_id, amount, transaction_code, checkout_request_id,
         payer_phone, status, callback_payload, idempotency_key, updated_at
       )
       VALUES ($1, $2, $3, $4, $4, $5, 'pending', $6::jsonb, $7, NOW())
       ON CONFLICT (property_id, checkout_request_id) DO NOTHING`,
      [
        scope.propertyId,
        body.outlet_id,
        amount,
        stkResult.CheckoutRequestID,
        phone,
        JSON.stringify({ test_prompt: true }),
        `daraja-test:${scope.propertyId}:${stkResult.CheckoutRequestID}`,
      ],
    ));
  } catch (error) {
    console.error("Daraja accepted a test prompt, but it could not be recorded.", error);
    return NextResponse.json({ success: false, message: "Daraja accepted the test prompt, but the result could not be recorded." }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    message: `Daraja accepted the test prompt for the phone ending ${phone.slice(-4)}. Approve it on the phone to verify the callback. This test will not clear a bill.`,
    checkout_request_id: stkResult.CheckoutRequestID,
  }, { headers: { "Cache-Control": "no-store" } });
}
