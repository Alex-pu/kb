import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { databaseReady, getPool, localApiAuthorized, query } from "@/lib/db/postgres";
import { decryptSecret } from "@/lib/supabase/secret-crypto";

export const runtime = "nodejs";

interface DarajaCallbackBody {
  property_id?: string;
  outlet_id?: string;
  order_id?: string;
  bill_reference?: string;
  amount?: number;
  transaction_code?: string;
  payer_phone?: string;
  status?: "paid" | "failed" | "timeout";
  callback_payload?: Record<string, unknown>;
}

interface NormalizedCallback {
  property_id: string;
  outlet_id?: string;
  order_id?: string;
  bill_reference?: string;
  amount: number;
  transaction_code: string;
  checkout_request_id?: string;
  payer_phone?: string;
  status: "paid" | "failed" | "timeout";
  callback_payload: Record<string, unknown>;
}

interface DarajaPaymentRow {
  id: string;
  property_id: string;
  outlet_id: string | null;
  order_id: string | null;
  bill_reference: string | null;
  amount: number;
  transaction_code: string;
  checkout_request_id: string | null;
  payer_phone: string | null;
  status: "pending" | "paid" | "failed" | "timeout";
  callback_payload: Record<string, unknown> | null;
  applied_at: string | null;
  created_at: string;
  updated_at: string;
}

async function autoSettleRestaurantBill(payment: DarajaPaymentRow): Promise<{ status: string; message?: string }> {
  if (!payment.bill_reference || !/^[0-9]{6}$/.test(payment.bill_reference) ||
      !payment.outlet_id || payment.status !== "paid") {
    return { status: "not_applicable" };
  }
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_URL is not configured.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const paymentResult = await client.query<{
      id: string;
      property_id: string;
      outlet_id: string;
      bill_reference: string | null;
      order_id: string | null;
      transaction_code: string;
      amount: string;
      status: string;
      applied_at: Date | null;
    }>(
      `SELECT id, property_id, outlet_id, bill_reference, order_id, transaction_code, amount, status, applied_at
       FROM daraja_payments WHERE id = $1 FOR UPDATE`,
      [payment.id],
    );
    const storedPayment = paymentResult.rows[0];
    if (!storedPayment || storedPayment.status !== "paid" || storedPayment.applied_at) {
      await client.query("ROLLBACK");
      return { status: "already_applied" };
    }
    if (storedPayment.bill_reference !== payment.bill_reference ||
        !storedPayment.bill_reference ||
        storedPayment.order_id !== storedPayment.bill_reference) {
      await client.query("ROLLBACK");
      return { status: "not_applicable" };
    }

    const checkResult = await client.query<{
      id: string;
      property_id: string;
      company_id: string;
      outlet_id: string;
      bill_number: string;
      table_name: string;
      waiter_id: string;
      lines: Array<{
        item: { id: string; name: string; stock_tracked: boolean; prep_station: "kitchen" | "bar" };
        quantity: number;
      }>;
      total: string;
    }>(
      `SELECT rc.id, rc.property_id, p.company_id, rc.outlet_id, rc.bill_number, rc.table_name,
              rc.waiter_id, rc.lines, rc.total
       FROM restaurant_checks rc
       JOIN properties p ON p.id = rc.property_id
       WHERE rc.property_id = $1 AND rc.outlet_id = $2
         AND rc.bill_number = $3 AND rc.status = 'open'
       FOR UPDATE OF rc`,
      [storedPayment.property_id, storedPayment.outlet_id, storedPayment.bill_reference],
    );
    const check = checkResult.rows[0];
    if (!check) {
      await client.query("ROLLBACK");
      return { status: "no_open_bill" };
    }
    if (Math.abs(Number(check.total) - Number(storedPayment.amount)) > 0.009) {
      await client.query("ROLLBACK");
      return { status: "amount_mismatch", message: "The confirmed callback amount does not match the open bill." };
    }

    const pendingCharge = await client.query(
      `SELECT id FROM restaurant_room_charge_requests WHERE check_id = $1 AND status = 'pending'`,
      [check.id],
    );
    if (pendingCharge.rows[0]) {
      await client.query("ROLLBACK");
      return { status: "room_charge_pending", message: "Reception approval is still pending for this bill." };
    }

    const demands = new Map<string, { itemId: string; warehouse: "kitchen" | "bar"; quantity: number }>();
    for (const line of check.lines ?? []) {
      if (!line.item.stock_tracked) continue;
      const warehouse = line.item.prep_station === "bar" ? "bar" : "kitchen";
      const key = `${line.item.id}:${warehouse}`;
      const current = demands.get(key);
      demands.set(key, {
        itemId: line.item.id,
        warehouse,
        quantity: (current?.quantity ?? 0) + line.quantity,
      });
    }
    for (const demand of demands.values()) {
      const stock = await client.query<{ quantity: string }>(
        `SELECT quantity FROM stock_levels
         WHERE outlet_id = $1 AND item_id = $2 AND warehouse = $3
         FOR UPDATE`,
        [check.outlet_id, demand.itemId, demand.warehouse],
      );
      if (Number(stock.rows[0]?.quantity ?? 0) < demand.quantity) {
        await client.query("ROLLBACK");
        return { status: "insufficient_stock", message: "There is not enough stock to clear this bill." };
      }
    }
    for (const demand of demands.values()) {
      await client.query(
        `UPDATE stock_levels SET quantity = quantity - $1, updated_at = NOW()
         WHERE outlet_id = $2 AND item_id = $3 AND warehouse = $4`,
        [demand.quantity, check.outlet_id, demand.itemId, demand.warehouse],
      );
      await client.query(
        `INSERT INTO stock_movements
           (property_id, item_id, movement_type, quantity, source_outlet_id, source_warehouse,
            reference_type, reference_id, idempotency_key, actor_user_id)
         VALUES ($1, $2, 'restaurant_sale', $3, $4, $5, 'restaurant_check', $6, $7, $8)
         ON CONFLICT (property_id, idempotency_key) DO NOTHING`,
        [
          check.property_id,
          demand.itemId,
          demand.quantity,
          check.outlet_id,
          demand.warehouse,
          check.id,
          `restaurant-sale:${check.id}:${demand.itemId}:${demand.warehouse}`,
          check.waiter_id,
        ],
      );
    }
    await client.query(
      `INSERT INTO restaurant_check_payments
         (property_id, check_id, tender_type, amount, reference, idempotency_key)
       VALUES ($1, $2, 'mpesa', $3, $4, $5)
       ON CONFLICT (check_id, idempotency_key, tender_type) DO NOTHING`,
      [
        check.property_id,
        check.id,
        storedPayment.amount,
        storedPayment.transaction_code,
        `daraja:${storedPayment.id}`,
      ],
    );
    await client.query(
      `UPDATE restaurant_kots SET archived_at = NOW(), updated_at = NOW()
       WHERE check_id = $1 AND archived_at IS NULL AND status IN ('served', 'cancelled')`,
      [check.id],
    );
    await client.query(
      `UPDATE restaurant_checks SET status = 'settled', settled_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'open'`,
      [check.id],
    );
    await client.query(
      `UPDATE daraja_payments SET applied_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND applied_at IS NULL`,
      [storedPayment.id],
    );
    await client.query(
      `INSERT INTO audit_log (company_id, property_id, outlet_id, actor_user_id, action_type, resource_type, resource_id, payload_after)
       VALUES ($1, $2, $3, NULL, 'RESTAURANT_CHECK.DARAJA_SETTLE', 'restaurant_checks', $4, $5::jsonb)`,
      [
        check.company_id,
        check.property_id,
        check.outlet_id,
        check.id,
        JSON.stringify({
          payment_id: storedPayment.id,
          transaction_code: storedPayment.transaction_code,
          amount: storedPayment.amount,
          waiter_id: check.waiter_id,
        }),
      ],
    );
    await client.query("COMMIT");
    return { status: "settled" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function isValidSignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!secret || !signature) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const received = signature.replace(/^sha256=/, "").trim();
  if (expected.length !== received.length) return false;

  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(received, "utf8"));
}

function metadataValue(items: unknown, name: string) {
  if (!Array.isArray(items)) return undefined;
  const match = items.find((item) => typeof item === "object" && item && "Name" in item && item.Name === name);
  return typeof match === "object" && match && "Value" in match ? match.Value : undefined;
}

function normalizeCallback(raw: DarajaCallbackBody & Record<string, unknown>, request: Request): NormalizedCallback | null {
  const url = new URL(request.url);
  const stkCallback = (raw.Body as { stkCallback?: Record<string, unknown> } | undefined)?.stkCallback;
  if (stkCallback) {
    const resultCode = Number(stkCallback.ResultCode);
    const callbackMetadata = stkCallback.CallbackMetadata as { Item?: unknown[] } | undefined;
    const items = callbackMetadata?.Item;
    const amount = Number(metadataValue(items, "Amount") || 0);
    const receipt = String(metadataValue(items, "MpesaReceiptNumber") || "").trim().toUpperCase();
    const phone = metadataValue(items, "PhoneNumber");
    const checkoutRequestId = typeof stkCallback.CheckoutRequestID === "string" ? stkCallback.CheckoutRequestID : undefined;
    const transactionCode = receipt || checkoutRequestId;

    if (!url.searchParams.get("property_id") || !transactionCode) return null;

    return {
      property_id: url.searchParams.get("property_id") || "",
      outlet_id: url.searchParams.get("outlet_id") || undefined,
      order_id: url.searchParams.get("order_id") || undefined,
      bill_reference: url.searchParams.get("bill_reference") || undefined,
      amount,
      transaction_code: transactionCode,
      checkout_request_id: checkoutRequestId,
      payer_phone: phone ? String(phone) : undefined,
      status: resultCode === 0 ? "paid" : "failed",
      callback_payload: raw,
    };
  }

  if (typeof raw.TransID === "string" && raw.TransID.trim()) {
    const propertyId = url.searchParams.get("property_id") || raw.property_id || "";
    const transactionCode = raw.TransID.trim().toUpperCase();
    if (!propertyId) return null;
    return {
      property_id: propertyId,
      outlet_id: url.searchParams.get("outlet_id") || raw.outlet_id,
      order_id: raw.order_id,
      bill_reference: typeof raw.BillRefNumber === "string" ? raw.BillRefNumber.trim() : raw.bill_reference,
      amount: Number(raw.TransAmount || raw.amount || 0),
      transaction_code: transactionCode,
      payer_phone: raw.MSISDN ? String(raw.MSISDN) : raw.payer_phone,
      status: "paid",
      callback_payload: raw,
    };
  }

  const transactionCode = raw.transaction_code?.trim().toUpperCase();
  if (!raw.property_id || !transactionCode || !raw.status) return null;

  return {
    property_id: raw.property_id,
    outlet_id: raw.outlet_id,
    order_id: raw.order_id,
    bill_reference: raw.bill_reference,
    amount: Number(raw.amount || 0),
    transaction_code: transactionCode,
    payer_phone: raw.payer_phone,
    status: raw.status,
    callback_payload: raw.callback_payload || raw,
  };
}

export async function POST(request: Request) {
  const rawBody = await request.text();

  let body: DarajaCallbackBody & Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as DarajaCallbackBody & Record<string, unknown>;
  } catch {
    return NextResponse.json({ success: false, message: "Callback body must be valid JSON." }, { status: 400 });
  }

  const normalized = normalizeCallback(body, request);
  if (!normalized || !normalized.property_id || !normalized.transaction_code || !normalized.status) {
    return NextResponse.json({ success: false, message: "Callback payload could not be matched to a property and transaction." }, { status: 400 });
  }

  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });

  const configResult = await query<{ callback_secret_encrypted: string }>(
    "SELECT callback_secret_encrypted FROM daraja_shop_configs WHERE property_id = $1 AND enabled = TRUE ORDER BY outlet_id NULLS LAST LIMIT 1",
    [normalized.property_id],
  );
  const config = configResult.rows[0];

  if (!config) {
    return NextResponse.json({ success: false, message: "No enabled Daraja configuration exists for this property." }, { status: 404 });
  }

  let callbackSecret: string;
  try {
    callbackSecret = decryptSecret(config.callback_secret_encrypted);
  } catch {
    return NextResponse.json({ success: false, message: "Daraja callback secret is not configured correctly." }, { status: 500 });
  }

  const callbackSecretParam = new URL(request.url).searchParams.get("secret");
  const hasValidSecretParam = !!callbackSecretParam && callbackSecretParam === callbackSecret;
  if (!hasValidSecretParam && !isValidSignature(rawBody, request.headers.get("x-daraja-signature"), callbackSecret)) {
    return NextResponse.json({ success: false, message: "Invalid callback signature." }, { status: 401 });
  }

  if (normalized.bill_reference?.startsWith("B")) {
    const legacyBill = await query<{ bill_number: string }>(
      `SELECT rc.bill_number
       FROM restaurant_bill_number_aliases alias
       JOIN restaurant_checks rc ON rc.id = alias.check_id
       WHERE alias.legacy_bill_number = $1 AND rc.property_id = $2`,
      [normalized.bill_reference, normalized.property_id],
    );
    const currentBillNumber = legacyBill.rows[0]?.bill_number;
    if (currentBillNumber) {
      const legacyBillNumber = normalized.bill_reference;
      normalized.bill_reference = currentBillNumber;
      if (normalized.order_id === legacyBillNumber) normalized.order_id = currentBillNumber;
    }
  }

  let existingPaymentId: string | undefined;
  let existingAmount = 0;
  if (normalized.checkout_request_id) {
    const existingResult = await query<{ id: string; amount: number }>(
      "SELECT id, amount FROM daraja_payments WHERE property_id = $1 AND checkout_request_id = $2 LIMIT 1",
      [normalized.property_id, normalized.checkout_request_id],
    );
    existingPaymentId = existingResult.rows[0]?.id;
    existingAmount = Number(existingResult.rows[0]?.amount || 0);
  }

  const amount = normalized.amount > 0 ? normalized.amount : existingAmount;
  if (amount <= 0) {
    return NextResponse.json({ success: false, message: "Callback amount is required before the bill can be cleared." }, { status: 400 });
  }

  const idempotencyKey = `daraja:${normalized.property_id}:${normalized.checkout_request_id || normalized.transaction_code}`;
  let payment: DarajaPaymentRow | undefined;
  try {
    const values = [
      normalized.property_id,
      normalized.outlet_id || null,
      normalized.order_id || null,
      normalized.bill_reference || null,
      amount,
      normalized.transaction_code,
      normalized.checkout_request_id || null,
      normalized.payer_phone || null,
      normalized.status,
      normalized.callback_payload,
      idempotencyKey,
      existingPaymentId || null,
    ];
    const paymentResult = await query<DarajaPaymentRow>(
      `
        WITH updated AS (
          UPDATE daraja_payments
          SET
            outlet_id = COALESCE($2, outlet_id),
            order_id = COALESCE($3, order_id),
            bill_reference = COALESCE($4, bill_reference),
            amount = $5,
            transaction_code = $6,
            checkout_request_id = COALESCE($7, checkout_request_id),
            payer_phone = COALESCE($8, payer_phone),
            status = $9,
            callback_payload = $10::jsonb,
            updated_at = NOW()
          WHERE id = $12
          RETURNING id, property_id, outlet_id, order_id, bill_reference, amount::float8 AS amount, transaction_code, checkout_request_id, payer_phone, status, callback_payload, applied_at, created_at, updated_at
        )
        INSERT INTO daraja_payments (
          property_id, outlet_id, order_id, bill_reference, amount, transaction_code,
          checkout_request_id, payer_phone, status, callback_payload, idempotency_key, updated_at
        )
        SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, NOW()
        WHERE NOT EXISTS (SELECT 1 FROM updated)
        ON CONFLICT (property_id, transaction_code)
        DO UPDATE SET
          outlet_id = COALESCE(EXCLUDED.outlet_id, daraja_payments.outlet_id),
          order_id = COALESCE(EXCLUDED.order_id, daraja_payments.order_id),
          bill_reference = COALESCE(EXCLUDED.bill_reference, daraja_payments.bill_reference),
          amount = EXCLUDED.amount,
          checkout_request_id = COALESCE(EXCLUDED.checkout_request_id, daraja_payments.checkout_request_id),
          payer_phone = COALESCE(EXCLUDED.payer_phone, daraja_payments.payer_phone),
          status = EXCLUDED.status,
          callback_payload = EXCLUDED.callback_payload,
          updated_at = NOW()
        RETURNING id, property_id, outlet_id, order_id, bill_reference, amount::float8 AS amount, transaction_code, checkout_request_id, payer_phone, status, callback_payload, applied_at, created_at, updated_at
      `,
      values,
    );
    payment = paymentResult.rows[0];
  } catch {
    return NextResponse.json({ success: false, message: "The callback could not be persisted." }, { status: 500 });
  }

  let autoSettlement: { status: string; message?: string } = { status: "not_applicable" };
  if (payment) {
    try {
      autoSettlement = await autoSettleRestaurantBill(payment);
    } catch (error) {
      console.error("Verified M-Pesa callback was saved, but restaurant bill settlement failed.", error);
      autoSettlement = { status: "pending", message: "The payment was verified, but this bill could not be cleared automatically. Ask the cashier to review it." };
    }
  }

  return NextResponse.json({
    success: true,
    accepted: true,
    payment,
    auto_settlement: autoSettlement,
  });
}

export async function GET(request: Request) {
  if (!localApiAuthorized(request)) return NextResponse.json({ success: false, message: "LOCAL_API_TOKEN is required for payment polling." }, { status: 401 });
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const propertyId = new URL(request.url).searchParams.get("property_id");
  if (!propertyId) return NextResponse.json({ success: false, message: "property_id is required." }, { status: 400 });

  const recentSince = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  try {
    const payments = await query<DarajaPaymentRow>(
      `
        SELECT id, property_id, outlet_id, order_id, bill_reference, amount::float8 AS amount,
          transaction_code, checkout_request_id, payer_phone, status, callback_payload,
          applied_at, created_at, updated_at
        FROM daraja_payments
        WHERE property_id = $1 AND created_at >= $2
        ORDER BY created_at DESC
        LIMIT 20
      `,
      [propertyId, recentSince],
    );
    return NextResponse.json({ success: true, payments: payments.rows });
  } catch {
    return NextResponse.json({ success: false, message: "Recent payments could not be loaded." }, { status: 500 });
  }
}
