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

function callbackResult(callbackPayload: unknown): { code: number | null; description: string | null } {
  if (typeof callbackPayload !== "object" || callbackPayload === null) return { code: null, description: null };
  const body = "Body" in callbackPayload ? callbackPayload.Body : undefined;
  if (typeof body !== "object" || body === null || !("stkCallback" in body)) return { code: null, description: null };
  const callback = body.stkCallback;
  if (typeof callback !== "object" || callback === null) return { code: null, description: null };
  const code = "ResultCode" in callback && Number.isFinite(Number(callback.ResultCode))
    ? Number(callback.ResultCode)
    : null;
  const description = "ResultDesc" in callback && typeof callback.ResultDesc === "string"
    ? callback.ResultDesc.slice(0, 300)
    : null;
  return { code, description };
}

export async function GET(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const outletId = params.get("outlet_id");
  const checkoutRequestId = params.get("checkout_request_id");
  if (!outletId || !checkoutRequestId) {
    return NextResponse.json({ success: false, message: "outlet_id and checkout_request_id are required." }, { status: 400 });
  }
  const scope = assertOutletAccess(auth.bundle, outletId);
  if (!scope) return NextResponse.json({ success: false, message: "You are not assigned to this outlet." }, { status: 403 });
  if (!hasPermission(auth.bundle, scope.propertyId, "restaurant:write")) {
    return NextResponse.json({ success: false, message: "You do not have permission to view this payment status." }, { status: 403 });
  }

  const result = await withUserContext(auth.userId, (run) => run<{
    id: string;
    bill_reference: string | null;
    amount: number;
    transaction_code: string;
    checkout_request_id: string;
    payer_phone_suffix: string;
    status: "pending" | "paid" | "failed" | "timeout";
    callback_payload: unknown;
    applied_at: Date | null;
    updated_at: Date;
  }>(
    `SELECT payment.id, payment.bill_reference, payment.amount::float8 AS amount,
            payment.transaction_code, payment.checkout_request_id,
            RIGHT(payment.payer_phone, 4) AS payer_phone_suffix,
            payment.status, payment.callback_payload, payment.applied_at, payment.updated_at
     FROM daraja_payments payment
     WHERE payment.property_id = $1 AND payment.outlet_id = $2
       AND payment.checkout_request_id = $3
       AND EXISTS (
         SELECT 1 FROM restaurant_checks check_record
         WHERE check_record.property_id = payment.property_id
           AND check_record.outlet_id = payment.outlet_id
           AND check_record.bill_number = payment.bill_reference
           AND (check_record.waiter_id = $4 OR $5)
       )`,
    [scope.propertyId, outletId, checkoutRequestId, auth.userId,
      hasPermission(auth.bundle, scope.propertyId, "restaurant:settle")],
  ));
  const payment = result.rows[0];
  if (!payment) return NextResponse.json({ success: false, message: "Payment request was not found for a bill you can access." }, { status: 404 });

  const callback = callbackResult(payment.callback_payload);
  return NextResponse.json({
    success: true,
    payment: {
      id: payment.id,
      bill_reference: payment.bill_reference,
      amount: payment.amount,
      transaction_code: payment.transaction_code,
      checkout_request_id: payment.checkout_request_id,
      payer_phone_suffix: payment.payer_phone_suffix,
      status: payment.status,
      callback_result_code: callback.code,
      callback_result_description: callback.description,
      cleared: Boolean(payment.applied_at),
      applied_at: payment.applied_at,
      updated_at: payment.updated_at,
    },
  }, { headers: { "Cache-Control": "no-store" } });
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
  if (!body.property_id || !body.order_id || !body.bill_reference || amount <= 0 || !phone) {
    return NextResponse.json({ success: false, message: "property_id, order_id, bill_reference, amount, and a valid payer_phone are required." }, { status: 400 });
  }
  if (!Number.isInteger(amount)) {
    return NextResponse.json({ success: false, message: "M-Pesa STK prompts require a whole-number amount in Kenyan shillings." }, { status: 400 });
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

  const configSql = `
    SELECT environment, short_code, consumer_key_encrypted, consumer_secret_encrypted,
      passkey_encrypted, callback_secret_encrypted, callback_url
    FROM daraja_shop_configs
    WHERE property_id = $1
      AND enabled = TRUE
      AND ($2::uuid IS NULL OR outlet_id = $2::uuid OR outlet_id IS NULL)
    ORDER BY CASE WHEN outlet_id = $2::uuid THEN 0 ELSE 1 END
    LIMIT 1
  `;
  const configValues = [body.property_id, body.outlet_id || null];
  const loadConfig = <T extends import("pg").QueryResultRow>(sql: string, values?: unknown[]) =>
    auth
      ? withUserContext(auth.userId, (run) => run<T>(sql, values))
      : query<T>(sql, values);
  const configResult = await loadConfig<{
    environment: "sandbox" | "production";
    short_code: string;
    consumer_key_encrypted: string;
    consumer_secret_encrypted: string;
    passkey_encrypted: string;
    callback_secret_encrypted: string;
    callback_url: string;
  }>(
    configSql,
    configValues,
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
  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64")}` },
    });
  } catch (error) {
    console.error("Daraja OAuth request failed for an STK prompt.", error);
    return NextResponse.json({ success: false, message: "Could not reach Daraja to send the M-Pesa prompt." }, { status: 502 });
  }
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
    console.error("Daraja STK push request failed.", error);
    return NextResponse.json({ success: false, message: "Could not reach Daraja to send the M-Pesa prompt." }, { status: 502 });
  }
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
    const payment = await query<{
      id: string;
      checkout_request_id: string;
      transaction_code: string;
      status: "pending" | "paid" | "failed" | "timeout";
      amount: number;
      bill_reference: string;
    }>(
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
        RETURNING id, checkout_request_id, transaction_code, status,
          amount::float8 AS amount, bill_reference
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
    const savedPayment = payment.rows[0];
    return NextResponse.json({
      success: true,
      message: `M-Pesa prompt sent to phone ending ${phone.slice(-4)}. Waiting for the customer to approve it.`,
      payment: { ...savedPayment, payer_phone_suffix: phone.slice(-4), callback_result_code: null, callback_result_description: null, cleared: false, applied_at: null },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ success: false, message: "The prompt was sent, but the pending payment could not be stored." }, { status: 500 });
  }
}
