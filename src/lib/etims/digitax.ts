import { createHash, randomBytes } from "node:crypto";
import type { QueryResultRow } from "pg";
import { withUserContext } from "@/lib/db/postgres";
import { decryptSecret } from "@/lib/supabase/secret-crypto";

const DIGITAX_API_BASE_URL = "https://api.digitax.tech/ke/v2";
const DIGITAX_CALLBACK_URL = "https://korebench.co.ke/api/integrations/digitax/callback";

export interface DigitaxSaleItem {
  id: string;
  quantity: number;
  unit_price: number;
  total_amount: number;
  item_name: string;
  item_class_code: string;
  item_bar_code: string;
  item_tax_type_code: string;
  taxable_amount?: number;
  tax_amount?: number;
  package_unit_quantity?: number;
  discount_rate?: number;
  discount_amount?: number;
  item_description?: string;
  is_stockable?: boolean;
}

export interface DigitaxSale {
  sale_date: string;
  trader_invoice_number: string;
  payment_type_code: string;
  invoice_status_code: string;
  customer_tin?: string;
  customer_name?: string;
  customer_id?: string;
  invoice_details?: string;
  is_tax_exempt?: boolean;
  items: DigitaxSaleItem[];
}

export interface DigitaxSaleSubmission {
  outlet_id: string;
  source_reference: string;
  idempotency_key: string;
  sale: DigitaxSale;
  restaurant_check_id?: string;
}

export interface DigitaxResult {
  status: "pending" | "submitted" | "failed" | "blocked" | "unknown";
  message: string;
  invoice_number?: string | null;
  receipt_number?: string | null;
  receipt_date?: string | null;
  signature?: string | null;
  verification_url?: string | null;
  customer_tin?: string | null;
  customer_name?: string | null;
}

interface ConfigRow extends QueryResultRow {
  enabled: boolean;
  api_base_url: string;
  callback_url: string;
  api_key_encrypted: string | null;
}

interface SubmissionRow extends QueryResultRow {
  status: DigitaxResult["status"];
  error_message: string | null;
  provider_reference: string | null;
  invoice_number: string | null;
  invoice_signature: string | null;
  scu_receipt_date: string | null;
  scu_receipt_number: string | null;
  verification_url: string | null;
  payload: DigitaxSale;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function saleResponseData(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return isRecord(value.data) ? value.data : value;
}

function validSale(sale: DigitaxSale): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sale.sale_date) ||
      !Number.isFinite(Date.parse(`${sale.sale_date}T00:00:00Z`)) ||
      new Date(`${sale.sale_date}T00:00:00Z`).toISOString().slice(0, 10) !== sale.sale_date) {
    return "sale_date must be a valid YYYY-MM-DD date.";
  }
  if (sale.sale_date > new Date().toISOString().slice(0, 10)) return "sale_date cannot be in the future.";
  if (!sale.trader_invoice_number.trim() || sale.trader_invoice_number.length > 160 ||
      !/^\d{2}$/.test(sale.payment_type_code) || !/^\d{2}$/.test(sale.invoice_status_code)) {
    return "The invoice number, payment type code, or invoice status code is invalid.";
  }
  if (sale.customer_tin && !/^[A-Z]\d{9}[A-Z]$/.test(sale.customer_tin)) {
    return "customer_tin must be a valid Kenyan PIN in the format P123456789Y.";
  }
  if (sale.customer_name && sale.customer_name.length > 255) return "customer_name must not exceed 255 characters.";
  if (!Array.isArray(sale.items) || sale.items.length === 0 || sale.items.length > 500) {
    return "A sale must contain between 1 and 500 items.";
  }
  for (const item of sale.items) {
    if (!item.id.trim() || item.id.length > 160 || !item.item_name.trim() || item.item_name.length > 255 ||
        !item.item_class_code.trim() || item.item_class_code.length > 80 ||
        !item.item_bar_code.trim() || item.item_bar_code.length > 80 ||
        !/^[ABCDE]$/.test(item.item_tax_type_code) ||
        !Number.isFinite(item.quantity) || item.quantity <= 0 ||
        !Number.isFinite(item.unit_price) || item.unit_price < 0 ||
        !Number.isFinite(item.total_amount) || item.total_amount < 0) {
      return "One or more sale items are missing valid DigiTax item codes, tax codes, or amounts.";
    }
    for (const optionalAmount of [
      item.taxable_amount,
      item.tax_amount,
      item.package_unit_quantity,
      item.discount_rate,
      item.discount_amount,
    ]) {
      if (optionalAmount !== undefined && (!Number.isFinite(optionalAmount) || optionalAmount < 0)) {
        return `One or more optional amounts for ${item.item_name} are invalid.`;
      }
    }
    if (Math.abs(item.quantity * item.unit_price - item.total_amount) > 0.01) {
      return `The total for ${item.item_name} does not match its quantity and unit price.`;
    }
  }
  return null;
}

function savedResult(row: SubmissionRow): DigitaxResult {
  return {
    status: row.status,
    message: row.error_message ?? `DigiTax status: ${row.status}.`,
    invoice_number: row.invoice_number,
    receipt_number: row.scu_receipt_number,
    receipt_date: row.scu_receipt_date,
    signature: row.invoice_signature,
    verification_url: row.verification_url,
    customer_tin: row.payload.customer_tin ?? null,
    customer_name: row.payload.customer_name ?? null,
  };
}

async function updateSubmission(
  userId: string,
  propertyId: string,
  idempotencyKey: string,
  result: DigitaxResult,
  providerReference: string | null,
  providerResponse: unknown,
) {
  await withUserContext(userId, (run) => run(
    `UPDATE etims_submissions
     SET status = $3, error_message = $4, provider_response = $5::jsonb,
         provider_reference = $6, invoice_number = $7, invoice_signature = $8,
         scu_receipt_date = $9, scu_receipt_number = $10, verification_url = $11,
         updated_at = NOW()
     WHERE property_id = $1 AND provider = 'digitax' AND idempotency_key = $2 AND status = 'pending'`,
    [propertyId, idempotencyKey, result.status, result.status === "submitted" ? null : result.message,
      providerResponse === undefined ? null : JSON.stringify(providerResponse), providerReference,
      result.invoice_number ?? null, result.signature ?? null, result.receipt_date ?? null,
      result.receipt_number ?? null, result.verification_url ?? null],
  ));
}

export async function submitDigitaxSale(
  userId: string,
  propertyId: string,
  input: DigitaxSaleSubmission,
  retryBlocked = false,
): Promise<DigitaxResult> {
  const saleError = validSale(input.sale);
  if (saleError) return { status: "blocked", message: saleError };
  if (!input.source_reference.trim() || input.source_reference.length > 160 ||
      !input.idempotency_key.trim() || input.idempotency_key.length > 160) {
    return { status: "blocked", message: "source_reference and idempotency_key are required and must be 160 characters or fewer." };
  }
  const callbackToken = randomBytes(32).toString("hex");
  const callbackTokenHash = createHash("sha256").update(callbackToken).digest("hex");
  const callbackUrl = new URL(DIGITAX_CALLBACK_URL);
  callbackUrl.searchParams.set("token", callbackToken);

  const preflight = await withUserContext(userId, async (run) => {
    const configResult = await run<ConfigRow>(
      `SELECT enabled, api_base_url, callback_url, api_key_encrypted
       FROM digitax_configs WHERE property_id = $1 AND outlet_id = $2`,
      [propertyId, input.outlet_id],
    );
    const config = configResult.rows[0];
    const existingResult = await run<SubmissionRow>(
      `SELECT status, error_message, provider_reference, invoice_number, invoice_signature,
              scu_receipt_date, scu_receipt_number, verification_url, payload
       FROM etims_submissions WHERE property_id = $1 AND provider = 'digitax' AND idempotency_key = $2`,
      [propertyId, input.idempotency_key],
    );
    const existing = existingResult.rows[0];
    if (existing && existing.status !== "blocked" && existing.status !== "failed") return { kind: "result" as const, result: savedResult(existing) };
    if (existing && !retryBlocked) return { kind: "result" as const, result: savedResult(existing) };

    let base: URL | null = null;
    if (config) {
      try {
        base = new URL(config.api_base_url.endsWith("/") ? config.api_base_url : `${config.api_base_url}/`);
      } catch {
        base = null;
      }
    }
    const validBase = Boolean(base && base.protocol === "https:" && !base.username &&
      !base.password && !base.hash && !base.search &&
      (base.hostname === "digitax.tech" || base.hostname.endsWith(".digitax.tech")));
    const problem = !config?.enabled ? "DigiTax is not enabled for this outlet."
      : !config.api_key_encrypted ? "Save a DigiTax API key in the outlet integration settings."
        : !validBase ? "The configured DigiTax API base URL must be a valid DigiTax HTTPS URL."
          : null;
    if (problem) {
      if (existing) {
        await run(
          `UPDATE etims_submissions SET error_message = $3, updated_at = NOW()
           WHERE property_id = $1 AND provider = 'digitax' AND idempotency_key = $2 AND status IN ('blocked', 'failed')`,
          [propertyId, input.idempotency_key, problem],
        );
      } else {
        await run(
          `INSERT INTO etims_submissions
             (property_id, outlet_id, provider, source_reference, idempotency_key, restaurant_check_id, payload, status, error_message, attempted_at)
           VALUES ($1, $2, 'digitax', $3, $4, $5, $6::jsonb, 'blocked', $7, NOW())
           ON CONFLICT (property_id, provider, idempotency_key) DO NOTHING`,
          [propertyId, input.outlet_id, input.source_reference, input.idempotency_key,
            input.restaurant_check_id ?? null, JSON.stringify(input.sale), problem],
        );
      }
      return { kind: "result" as const, result: { status: "blocked" as const, message: problem } };
    }

    if (!config?.api_key_encrypted) {
      return { kind: "result" as const, result: { status: "blocked" as const, message: "Save a DigiTax API key in the outlet integration settings." } };
    }
    let apiKey: string;
    try {
      apiKey = decryptSecret(config.api_key_encrypted);
    } catch (error) {
      console.error("Unable to decrypt DigiTax API key.", error);
      return { kind: "result" as const, result: { status: "blocked" as const, message: "The DigiTax API key could not be decrypted. Re-enter it in integration settings." } };
    }

    if (existing) {
      const update = await run(
        `UPDATE etims_submissions SET status = 'pending', payload = $3::jsonb, callback_token_hash = $4,
           error_message = NULL, attempted_at = NOW(), updated_at = NOW()
         WHERE property_id = $1 AND provider = 'digitax' AND idempotency_key = $2 AND status IN ('blocked', 'failed')
         RETURNING id`,
        [propertyId, input.idempotency_key, JSON.stringify(input.sale), callbackTokenHash],
      );
      if (!update.rowCount) return { kind: "result" as const, result: { status: "unknown" as const, message: "Another DigiTax submission is already in progress or requires reconciliation." } };
    } else {
      const claim = await run(
        `INSERT INTO etims_submissions
           (property_id, outlet_id, provider, source_reference, idempotency_key, restaurant_check_id, payload, status, callback_token_hash, attempted_at)
         VALUES ($1, $2, 'digitax', $3, $4, $5, $6::jsonb, 'pending', $7, NOW())
         ON CONFLICT (property_id, provider, idempotency_key) DO NOTHING
         RETURNING id`,
        [propertyId, input.outlet_id, input.source_reference, input.idempotency_key,
          input.restaurant_check_id ?? null, JSON.stringify(input.sale), callbackTokenHash],
      );
      if (!claim.rowCount) {
        return { kind: "result" as const, result: { status: "unknown" as const, message: "A DigiTax submission attempt already exists for this idempotency key. Refresh its status before proceeding." } };
      }
    }

    if (!base) return { kind: "result" as const, result: { status: "blocked" as const, message: "The configured DigiTax API base URL is invalid." } };
    return {
      kind: "submission" as const,
      sale: input.sale,
      apiKey,
      apiUrl: new URL("sales-with-items", base).toString(),
      callbackUrl: config?.callback_url
        ? new URL(callbackUrl.search, config.callback_url).toString()
        : callbackUrl.toString(),
    };
  });

  if (preflight.kind === "result") return preflight.result;

  let responseBody: unknown;
  let status: DigitaxResult["status"] = "unknown";
  let resultMessage = "The DigiTax response could not be confirmed. Verify the sale with DigiTax before retrying.";
  let invoiceNumber: string | null = null;
  let receiptNumber: string | null = null;
  let receiptDate: string | null = null;
  let signature: string | null = null;
  let verificationUrl: string | null = null;
  let providerReference: string | null = null;
  let customerTin = preflight.sale.customer_tin ?? null;
  let customerName = preflight.sale.customer_name ?? null;

  try {
    const response = await fetch(preflight.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": preflight.apiKey },
      body: JSON.stringify({ ...preflight.sale, callback_url: preflight.callbackUrl }),
      signal: AbortSignal.timeout(25000),
      cache: "no-store",
      redirect: "error",
    });
    const responseText = await response.text();
    try {
      responseBody = responseText ? JSON.parse(responseText) as unknown : null;
    } catch {
      responseBody = { response_text: responseText.slice(0, 2000) };
    }

    if (response.status !== 201) {
      const providerMessage = saleResponseData(responseBody)?.message;
      const rejectionDetail = typeof providerMessage === "string" ? ` DigiTax: ${providerMessage.slice(0, 500)}` : "";
      status = response.status >= 500 || response.status === 409
        ? "unknown"
        : response.status >= 400 && response.status < 500 ? "blocked" : "unknown";
      resultMessage = response.status >= 500
        ? `DigiTax returned HTTP ${response.status}; confirm the sale with DigiTax before retrying.`
        : response.status === 409
          ? "DigiTax returned a conflict. Verify whether the sale already exists before retrying."
          : `DigiTax rejected the sale with HTTP ${response.status}.${rejectionDetail} Correct the issue before retrying.`;
    } else {
      const data = saleResponseData(responseBody);
      const invoice = data?.invoice_number;
      const receipt = data?.receipt_number;
      const date = data?.date;
      const saleId = data?.id;
      const providerStatusValue = data?.status ?? data?.queue_status;
      const providerStatus = typeof providerStatusValue === "string" ? providerStatusValue.toUpperCase() : "";
      const responseCustomerTin = data?.customer_tin;
      const responseCustomerName = data?.customer_name;
      const sig = data?.receipt_signature;
      const url = data?.etims_url;
      invoiceNumber = typeof invoice === "string" || typeof invoice === "number" ? String(invoice) : null;
      receiptNumber = typeof receipt === "string" || typeof receipt === "number" ? String(receipt) : null;
      receiptDate = typeof date === "string" ? date : null;
      providerReference = typeof saleId === "string" ? saleId : null;
      customerTin = typeof responseCustomerTin === "string" ? responseCustomerTin : customerTin;
      customerName = typeof responseCustomerName === "string" ? responseCustomerName : customerName;
      signature = typeof sig === "string" ? sig : null;
      verificationUrl = typeof url === "string" && (() => {
        try { return new URL(url).protocol === "https:"; } catch { return false; }
      })() ? url : null;
      if (typeof data?.kra_response_message === "string" && data.kra_response_message.trim()) {
        status = "blocked";
        resultMessage = `DigiTax reported a KRA sale failure: ${data.kra_response_message.slice(0, 500)}`;
      } else if (providerStatus === "FAILED") {
        status = "blocked";
        resultMessage = "DigiTax reports that KRA failed this sale. Correct the issue before retrying.";
      } else if (providerStatus === "PENDING") {
        status = "pending";
        resultMessage = "DigiTax has not confirmed KRA synchronization yet. Verify the sale with DigiTax before printing or retrying.";
      } else if (providerStatus && providerStatus !== "COMPLETED") {
        resultMessage = `DigiTax returned an unrecognized sale status (${providerStatus}). Verify the sale before retrying.`;
      } else if (invoiceNumber && signature && verificationUrl) {
        status = "submitted";
        resultMessage = "DigiTax signed the eTIMS receipt successfully.";
      } else {
        resultMessage = "DigiTax accepted the request but did not return all signed receipt details. Verify it in DigiTax before retrying.";
      }
    }
  } catch (error) {
    resultMessage = error instanceof Error && error.name === "TimeoutError"
      ? "The DigiTax request timed out. Its status is unknown; verify the sale with DigiTax before retrying."
      : "The DigiTax request failed after it was started. Its status is unknown; verify the sale with DigiTax before retrying.";
    console.error("DigiTax sale request failed.", error);
  }

  const result: DigitaxResult = {
    status,
    message: resultMessage,
    invoice_number: invoiceNumber,
    receipt_number: receiptNumber,
    receipt_date: receiptDate,
    signature,
    verification_url: verificationUrl,
    customer_tin: customerTin,
    customer_name: customerName,
  };
  await updateSubmission(userId, propertyId, input.idempotency_key, result, providerReference, responseBody);
  return result;
}

export { DIGITAX_API_BASE_URL, DIGITAX_CALLBACK_URL };
