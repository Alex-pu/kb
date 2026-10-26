import { NextResponse } from "next/server";
import { assertOutletAccess, getAuthContext, hasPermission } from "@/lib/auth/require-session";
import { databaseReady, localApiAuthorized, query, withUserContext } from "@/lib/db/postgres";
import { decryptSecret } from "@/lib/supabase/secret-crypto";

export const runtime = "nodejs";

interface PromptBody {
  property_id?: string;
  outlet_id?: string;
  order_id?: string;
  bill_reference?: string;
  amount?: number;
  payer_phone?: string;
}

function darajaBaseUrl(environment: "sandbox" | "production") {
  return environment === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";
}

function timestamp() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function normalizePhone(phone: string) {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("254") && digits.length === 12) return digits;
  if (digits.startsWith("0") && digits.length === 10) return `254${digits.slice(1)}`;
  if (digits.length === 9 && (digits.startsWith("7") || digits.startsWith("1"))) return `254${digits}`;
  return "";
}

function appendCallbackParams(callbackUrl: string, params: Record<string, string | undefined>) {
  const url = new URL(callbackUrl);
  Object.entries(params).forEach(([key, value]) => {
    if (value) url.searchParams.set(key, value);
  });
  return url.toString();
}

export async function POST(request: Request) {
  const localAuthorized = localApiAuthorized(request);
  const auth = localAuthorized ? null : await getAuthContext();
  if (!localAuthorized && !auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });

  let body: PromptBody;
  try {
    body = await request.json() as PromptBody;
  } catch {
    return NextResponse.json({ success: false, message: "Prompt body must be valid JSON." }, { status: 400 });
  }

  const amount = Number(body.amount || 0);
  const phone = normalizePhone(body.payer_phone || "");
  if (!body.property_id || !body.order_id || !body.bill_reference || amount <= 0 || !Number.isInteger(amount) || !phone) {
    return NextResponse.json({ success: false, message: "property_id, order_id, bill_reference, amount, and a valid payer_phone are required." }, { status: 400 });
  }
  if (!localAuthorized && auth) {
    const outletId = body.outlet_id || "";
    const scope = assertOutletAccess(auth.bundle, outletId);
    if (!scope || scope.propertyId !== body.property_id) {
      return NextResponse.json({ success: false, message: "You are not assigned to this restaurant outlet." }, { status: 403 });
    }
    if (!hasPermission(auth.bundle, scope.propertyId, "restaurant:write")) {
      return NextResponse.json({ success: false, message: "Only the assigned waiter can request a bill payment prompt." }, { status: 403 });
    }
    if (!/^[0-9]{6}$/.test(body.bill_reference) || body.order_id !== body.bill_reference) {
      return NextResponse.json({ success: false, message: "Prompt must use the unique bill number as its account reference." }, { status: 400 });
    }
    const check = await withUserContext(auth.userId, async (run) => run<{ total: string }>(
      `SELECT rc.total FROM restaurant_checks rc
       WHERE rc.property_id = $1 AND rc.outlet_id = $2 AND rc.bill_number = $3
         AND rc.waiter_id = $4 AND rc.status = 'open'
         AND NOT EXISTS (
           SELECT 1 FROM restaurant_room_charge_requests charge
           WHERE charge.check_id = rc.id AND charge.status = 'pending'
         )
         AND NOT EXISTS (
           SELECT 1 FROM daraja_payments payment
           WHERE payment.property_id = rc.property_id AND payment.outlet_id = rc.outlet_id
             AND payment.bill_reference = $5 AND payment.status = 'pending'
             AND payment.created_at > NOW() - INTERVAL '5 minutes'
         )
       FOR UPDATE`,
      [scope.propertyId, outletId, body.bill_reference, auth.userId, body.bill_reference],
    ));
    if (!check.rows[0] || Math.abs(Number(check.rows[0].total) - amount) > 0.009) {
      return NextResponse.json({ success: false, message: "The open bill could not be verified or its total has changed." }, { status: 409 });
    }
  }

  const configResult = await query<{
    environment: "sandbox" | "production";
    short_code: string;
    consumer_key_encrypted: string;
    consumer_secret_encrypted: string;
    passkey_encrypted: string;
    callback_secret_encrypted: string;
    callback_url: string;
  }>(
    `
      SELECT environment, short_code, consumer_key_encrypted, consumer_secret_encrypted,
        passkey_encrypted, callback_secret_encrypted, callback_url
      FROM daraja_shop_configs
      WHERE property_id = $1
        AND enabled = TRUE
        AND ($2::uuid IS NULL OR outlet_id = $2::uuid)
      ORDER BY outlet_id NULLS LAST
      LIMIT 1
    `,
    [body.property_id, body.outlet_id || null],
  );
  const config = configResult.rows[0];
  if (!config) {
    return NextResponse.json({ success: false, message: "No enabled Daraja configuration exists for this property." }, { status: 404 });
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
  } catch {
    return NextResponse.json({ success: false, message: "Daraja credentials are not configured correctly." }, { status: 500 });
  }

  const baseUrl = darajaBaseUrl(config.environment);
  const tokenResponse = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64")}` },
  });
  const tokenPayload = await tokenResponse.json().catch(() => ({})) as { access_token?: string; errorMessage?: string };
  if (!tokenResponse.ok || !tokenPayload.access_token) {
    return NextResponse.json({ success: false, message: tokenPayload.errorMessage || "Daraja access token request failed." }, { status: 502 });
  }

  const requestTimestamp = timestamp();
  const accountReference = body.bill_reference.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "BILL";
  const stkPayload = {
    BusinessShortCode: config.short_code,
    Password: Buffer.from(`${config.short_code}${passkey}${requestTimestamp}`).toString("base64"),
    Timestamp: requestTimestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: Math.round(amount),
    PartyA: phone,
    PartyB: config.short_code,
    PhoneNumber: phone,
    CallBackURL: appendCallbackParams(config.callback_url, {
      property_id: body.property_id,
      outlet_id: body.outlet_id,
      order_id: body.order_id,
      bill_reference: body.bill_reference,
      secret: callbackSecret,
    }),
    AccountReference: accountReference,
    TransactionDesc: "Bill payment",
  };

  const stkResponse = await fetch(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenPayload.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(stkPayload),
  });
  const stkResult = await stkResponse.json().catch(() => ({})) as {
    MerchantRequestID?: string;
    CheckoutRequestID?: string;
    ResponseCode?: string;
    ResponseDescription?: string;
    errorMessage?: string;
  };

  if (!stkResponse.ok || stkResult.ResponseCode !== "0" || !stkResult.CheckoutRequestID) {
    return NextResponse.json({ success: false, message: stkResult.errorMessage || stkResult.ResponseDescription || "M-Pesa prompt could not be sent." }, { status: 502 });
  }

  const idempotencyKey = `daraja-prompt:${body.property_id}:${stkResult.CheckoutRequestID}`;
  try {
    const payment = await query(
      `
        INSERT INTO daraja_payments (
          property_id, outlet_id, order_id, bill_reference, amount, transaction_code,
          checkout_request_id, payer_phone, status, callback_payload, idempotency_key, applied_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $6, $7, 'pending', $8::jsonb, $9, NULL, NOW())
        ON CONFLICT (property_id, checkout_request_id) WHERE checkout_request_id IS NOT NULL
        DO UPDATE SET
          order_id = EXCLUDED.order_id,
          bill_reference = EXCLUDED.bill_reference,
          amount = EXCLUDED.amount,
          payer_phone = EXCLUDED.payer_phone,
          callback_payload = EXCLUDED.callback_payload,
          updated_at = NOW()
        RETURNING id, property_id, outlet_id, order_id, bill_reference, amount::float8 AS amount,
          transaction_code, checkout_request_id, payer_phone, status, callback_payload,
          applied_at, created_at, updated_at
      `,
      [
        body.property_id,
        body.outlet_id || null,
        body.order_id,
        body.bill_reference,
        amount,
        stkResult.CheckoutRequestID,
        phone,
        stkResult,
        idempotencyKey,
      ],
    );
    return NextResponse.json({ success: true, message: "M-Pesa prompt sent. The bill will clear when the callback confirms payment.", payment: payment.rows[0] });
  } catch {
    return NextResponse.json({ success: false, message: "The prompt was sent, but the pending payment could not be stored." }, { status: 500 });
  }
}
