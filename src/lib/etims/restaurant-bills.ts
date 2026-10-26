import type { QueryResultRow } from "pg";
import { withUserContext } from "@/lib/db/postgres";
import { decryptSecret } from "@/lib/supabase/secret-crypto";

type FiscalStatus = "pending" | "submitted" | "failed" | "blocked" | "unknown";

interface CheckRow extends QueryResultRow {
  id: string;
  bill_number: string;
  property_id: string;
  outlet_id: string;
  lines: Array<{ item?: { id?: string; name?: string; price?: number }; quantity?: number }>;
  total: string;
  status: string;
  settled_at: string | null;
}

interface ConfigRow extends QueryResultRow {
  etims_enabled: boolean;
  etims_business_name: string | null;
  etims_endpoint: string | null;
  etims_username: string | null;
  etims_password_encrypted: string | null;
}

interface MappingRow extends QueryResultRow {
  id: string;
  name: string;
  etims_item_code: string | null;
  etims_tax_code: string | null;
}

interface PaymentRow extends QueryResultRow {
  tender_type: string;
}

interface InvoiceItem {
  itemCode: string;
  taxCode: string;
  qty: number;
  pkg: number;
  unitPrice: number;
  amount: number;
  discountAmount: number;
}

interface InvoicePayload {
  traderInvoiceNo: string;
  totalAmount: number;
  paymentType: string;
  salesTypeCode: "N";
  receiptTypeCode: "S";
  salesStatusCode: "01";
  salesDate: string;
  currency: "KES";
  exchangeRate: 1;
  salesItems: InvoiceItem[];
}

interface Result {
  status: FiscalStatus;
  message: string;
  invoice_number?: string | null;
  scdc_id?: string | null;
  signature?: string | null;
  receipt_number?: string | null;
  receipt_date?: string | null;
  verification_url?: string | null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function dateForEtims(value: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h12",
  }).formatToParts(new Date(value));
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}${read("month")}${read("day")}${read("hour")}${read("minute")}${read("second")}`;
}

function paymentCode(types: string[]): string {
  const unique = [...new Set(types)];
  if (unique.length === 1) {
    return ({ cash: "01", room_charge: "02", card: "05", mpesa: "06" } as Record<string, string>)[unique[0]] ?? "07";
  }
  return unique.includes("cash") && unique.includes("room_charge") ? "03" : "07";
}

function responseData(body: unknown): Record<string, unknown> | null {
  const root = objectValue(body);
  return objectValue(root?.data) ?? root;
}

async function setSubmission(userId: string, propertyId: string, checkId: string, values: {
  status: FiscalStatus;
  error?: string | null;
  providerResponse?: unknown;
  invoiceNumber?: string | null;
  scdcId?: string | null;
  signature?: string | null;
  receiptDate?: string | null;
  receiptNumber?: string | null;
  verificationUrl?: string | null;
}) {
  await withUserContext(userId, (run) => run(
    `UPDATE etims_submissions
     SET status = $3, error_message = $4, provider_response = $5::jsonb,
         invoice_number = $6, scdc_id = $7, invoice_signature = $8,
         scu_receipt_date = $9, scu_receipt_number = $10, verification_url = $11,
         updated_at = NOW()
     WHERE property_id = $1 AND restaurant_check_id = $2 AND status = 'pending'`,
    [propertyId, checkId, values.status, values.error ?? null,
      values.providerResponse === undefined ? null : JSON.stringify(values.providerResponse),
      values.invoiceNumber ?? null, values.scdcId ?? null, values.signature ?? null,
      values.receiptDate ?? null, values.receiptNumber ?? null, values.verificationUrl ?? null],
  ));
}

export async function fiscalizeRestaurantBill(userId: string, propertyId: string, outletId: string, checkId: string, retryBlocked = false): Promise<Result> {
  const preflight = await withUserContext(userId, async (run) => {
    const checkResult = await run<CheckRow>(
      `SELECT id, bill_number, property_id, outlet_id, lines, total, status, settled_at
       FROM restaurant_checks
       WHERE id = $1 AND property_id = $2 AND outlet_id = $3`,
      [checkId, propertyId, outletId],
    );
    const check = checkResult.rows[0];
    if (!check || check.status !== "settled" || !check.settled_at) {
      return { status: "blocked" as const, message: "Only a paid restaurant bill can be submitted to eTIMS." };
    }
    const configResult = await run<ConfigRow>(
      `SELECT etims_enabled, etims_business_name, etims_endpoint, etims_username, etims_password_encrypted
       FROM property_integration_configs
       WHERE property_id = $1 AND outlet_id = $2`,
      [propertyId, outletId],
    );
    const config = configResult.rows[0];
    const existingResult = await run<{ status: FiscalStatus; error_message: string | null; invoice_number: string | null }>(
      `SELECT status, error_message, invoice_number
       FROM etims_submissions WHERE property_id = $1 AND restaurant_check_id = $2`,
      [propertyId, checkId],
    );
    const existing = existingResult.rows[0];
    if (existing && existing.status !== "blocked") {
      return { status: existing.status, message: existing.error_message ?? `eTIMS status: ${existing.status}.`, invoice_number: existing.invoice_number };
    }
    if (existing && !retryBlocked) {
      return { status: "blocked" as const, message: existing.error_message ?? "This bill is blocked from eTIMS submission." };
    }

    const itemIds = [...new Set((check.lines ?? []).map((line) => line.item?.id).filter((id): id is string => Boolean(id)))];
    const mappingResult = itemIds.length ? await run<MappingRow>(
      `SELECT id, name, etims_item_code, etims_tax_code
       FROM items WHERE property_id = $1 AND id = ANY($2::uuid[])`,
      [propertyId, itemIds],
    ) : { rows: [] as MappingRow[] };
    const mappings = new Map(mappingResult.rows.map((item) => [item.id, item]));
    const unmapped = (check.lines ?? []).find((line) => {
      const mapping = line.item?.id ? mappings.get(line.item.id) : undefined;
      return !mapping?.etims_item_code || !mapping.etims_tax_code || !/^[ABCDE]$/.test(mapping.etims_tax_code);
    });
    const problem = !config?.etims_enabled ? "eTIMS is not enabled for this outlet."
      : !config.etims_endpoint || !config.etims_username || !config.etims_password_encrypted || !config.etims_business_name
        ? "Complete the eTIMS endpoint, business name, username, and encrypted password in Settings."
        : unmapped ? `Add a valid eTIMS item and tax code mapping for ${unmapped.item?.name ?? "every item"} in Catalog.`
          : null;
    if (problem) {
      if (existing?.status === "blocked") {
        await run(
          `UPDATE etims_submissions SET error_message = $3, updated_at = NOW()
           WHERE property_id = $1 AND restaurant_check_id = $2 AND status = 'blocked'`,
          [propertyId, checkId, problem],
        );
      } else {
        await run(
          `INSERT INTO etims_submissions
             (property_id, outlet_id, source_reference, idempotency_key, restaurant_check_id, payload, status, error_message, attempted_at)
           VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, 'blocked', $6, NOW())
           ON CONFLICT (property_id, restaurant_check_id) WHERE restaurant_check_id IS NOT NULL DO NOTHING`,
          [propertyId, outletId, check.bill_number, `restaurant-check:${checkId}`, checkId, problem],
        );
      }
      return { status: "blocked" as const, message: problem };
    }

    let password: string;
    try {
      password = decryptSecret(config.etims_password_encrypted!);
    } catch (error) {
      console.error("Unable to decrypt eTIMS provider password.", error);
      const message = "The saved eTIMS password cannot be decrypted. Re-enter it in Settings.";
      if (existing?.status === "blocked") {
        await run(`UPDATE etims_submissions SET error_message = $3 WHERE property_id = $1 AND restaurant_check_id = $2 AND status = 'blocked'`, [propertyId, checkId, message]);
      } else {
        await run(
          `INSERT INTO etims_submissions
             (property_id, outlet_id, source_reference, idempotency_key, restaurant_check_id, payload, status, error_message, attempted_at)
           VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, 'blocked', $6, NOW())
           ON CONFLICT (property_id, restaurant_check_id) WHERE restaurant_check_id IS NOT NULL DO NOTHING`,
          [propertyId, outletId, check.bill_number, `restaurant-check:${checkId}`, checkId, message],
        );
      }
      return { status: "blocked" as const, message };
    }

    const payments = await run<PaymentRow>(
      "SELECT DISTINCT tender_type FROM restaurant_check_payments WHERE check_id = $1",
      [checkId],
    );
    const salesItems: InvoiceItem[] = [];
    for (const line of check.lines ?? []) {
      const itemId = line.item?.id;
      const mapping = itemId ? mappings.get(itemId) : undefined;
      const quantity = Number(line.quantity);
      const unitPrice = Number(line.item?.price);
      if (!mapping || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) {
        return { status: "blocked" as const, message: "Bill item details are incomplete; no invoice was sent." };
      }
      salesItems.push({
        itemCode: mapping.etims_item_code!,
        taxCode: mapping.etims_tax_code!,
        qty: quantity,
        pkg: 0,
        unitPrice,
        amount: Math.round(unitPrice * quantity * 100) / 100,
        discountAmount: 0,
      });
    }
    const total = Number(check.total);
    const lineTotal = Math.round(salesItems.reduce((sum, line) => sum + line.amount, 0) * 100) / 100;
    if (!salesItems.length || !Number.isFinite(total) || Math.abs(lineTotal - total) > 0.01) {
      const message = "The bill line totals do not match the paid bill total; no invoice was sent.";
      if (existing?.status === "blocked") {
        await run(`UPDATE etims_submissions SET error_message = $3 WHERE property_id = $1 AND restaurant_check_id = $2 AND status = 'blocked'`, [propertyId, checkId, message]);
      } else {
        await run(
          `INSERT INTO etims_submissions
             (property_id, outlet_id, source_reference, idempotency_key, restaurant_check_id, payload, status, error_message, attempted_at)
           VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, 'blocked', $6, NOW())
           ON CONFLICT (property_id, restaurant_check_id) WHERE restaurant_check_id IS NOT NULL DO NOTHING`,
          [propertyId, outletId, check.bill_number, `restaurant-check:${checkId}`, checkId, message],
        );
      }
      return { status: "blocked" as const, message };
    }
    const payload: InvoicePayload = {
      traderInvoiceNo: check.bill_number,
      totalAmount: total,
      paymentType: paymentCode(payments.rows.map((payment) => payment.tender_type)),
      salesTypeCode: "N",
      receiptTypeCode: "S",
      salesStatusCode: "01",
      salesDate: dateForEtims(check.settled_at),
      currency: "KES",
      exchangeRate: 1,
      salesItems,
    };
    if (existing?.status === "blocked") {
      const update = await run(
        `UPDATE etims_submissions SET status = 'pending', payload = $3::jsonb, error_message = NULL,
           attempted_at = NOW(), updated_at = NOW()
         WHERE property_id = $1 AND restaurant_check_id = $2 AND status = 'blocked'
         RETURNING id`,
        [propertyId, checkId, JSON.stringify(payload)],
      );
      if (!update.rowCount) return { status: "unknown" as const, message: "This bill already has an eTIMS submission attempt. Reconcile it before another submission." };
    } else {
      const claim = await run(
        `INSERT INTO etims_submissions
           (property_id, outlet_id, source_reference, idempotency_key, restaurant_check_id, payload, status, attempted_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'pending', NOW())
         ON CONFLICT (property_id, restaurant_check_id) WHERE restaurant_check_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [propertyId, outletId, check.bill_number, `restaurant-check:${checkId}`, checkId, JSON.stringify(payload)],
      );
      if (!claim.rowCount) return { status: "unknown" as const, message: "Another eTIMS submission attempt already exists for this bill." };
    }
    return {
      status: "pending" as const,
      message: "eTIMS submission started.",
      payload,
      endpoint: config.etims_endpoint!,
      username: config.etims_username!,
      password,
    };
  });

  if (!("payload" in preflight) || typeof preflight.endpoint !== "string" ||
      typeof preflight.username !== "string" || typeof preflight.password !== "string") return preflight;
  let status: FiscalStatus = "blocked";
  let errorMessage: string | null = null;
  let providerResponse: unknown;
  let invoiceNumber: string | null = null;
  let scdcId: string | null = null;
  let signature: string | null = null;
  let receiptDate: string | null = null;
  let receiptNumber: string | null = null;
  let verificationUrl: string | null = null;
  let invoiceRequestStarted = false;

  try {
    const base = new URL(preflight.endpoint.endsWith("/") ? preflight.endpoint : `${preflight.endpoint}/`);
    if (base.protocol !== "https:" || base.username || base.password) throw new Error("The configured eTIMS endpoint is not a valid HTTPS URL.");
    const loginResponse = await fetch(new URL("users/auth", base), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: preflight.username, password: preflight.password }),
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
    if (!loginResponse.ok) throw new Error(`eTIMS authentication failed with HTTP ${loginResponse.status}; no invoice was sent.`);
    const loginBody: unknown = await loginResponse.json();
    const token = responseData(loginBody)?.accessToken;
    if (typeof token !== "string" || !token) throw new Error("eTIMS authentication response did not contain an access token; no invoice was sent.");

    invoiceRequestStarted = true;
    const invoiceResponse = await fetch(new URL("invoices", base), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(preflight.payload),
      signal: AbortSignal.timeout(20000),
      cache: "no-store",
    });
    const text = await invoiceResponse.text();
    try { providerResponse = text ? JSON.parse(text) as unknown : null; }
    catch { providerResponse = { response_text: text.slice(0, 2000) }; }
    if (!invoiceResponse.ok) {
      status = "failed";
      errorMessage = `eTIMS rejected the invoice with HTTP ${invoiceResponse.status}. Do not retry until the provider confirms no invoice was created.`;
    } else {
      const response = responseData(providerResponse);
      const number = response?.invoiceNo;
      const sig = response?.signature;
      const url = response?.invoiceVerificationUrl;
      invoiceNumber = typeof number === "string" || typeof number === "number" ? String(number) : null;
      scdcId = typeof response?.scdcId === "string" ? response.scdcId : null;
      signature = typeof sig === "string" ? sig : null;
      receiptDate = typeof response?.scuReceiptDate === "string" ? response.scuReceiptDate : null;
      receiptNumber = typeof response?.scuReceiptNo === "string" || typeof response?.scuReceiptNo === "number" ? String(response.scuReceiptNo) : null;
      verificationUrl = typeof url === "string" && (() => { try { return new URL(url).protocol === "https:"; } catch { return false; } })() ? url : null;
      if (invoiceNumber && signature && verificationUrl) status = "submitted";
      else {
        status = "unknown";
        errorMessage = "The provider response did not include the invoice number, signature, and HTTPS verification URL. Verify with the provider before retrying.";
      }
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "eTIMS request failed.";
    status = invoiceRequestStarted ? "unknown" : "blocked";
  }

  await setSubmission(userId, propertyId, checkId, {
    status,
    error: errorMessage,
    providerResponse,
    invoiceNumber,
    scdcId,
    signature,
    receiptDate,
    receiptNumber,
    verificationUrl,
  });
  return {
    status,
    message: errorMessage ?? "eTIMS invoice signed successfully.",
    invoice_number: invoiceNumber,
    scdc_id: scdcId,
    signature,
    receipt_number: receiptNumber,
    receipt_date: receiptDate,
    verification_url: verificationUrl,
  };
}
