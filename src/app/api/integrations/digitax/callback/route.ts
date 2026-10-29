import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { databaseReady, query } from "@/lib/db/postgres";

export const runtime = "nodejs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false }, { status: 503 });

  const token = new URL(request.url).searchParams.get("token");
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    return NextResponse.json({ success: false }, { status: 401 });
  }

  let body: unknown;
  try {
    const rawBody = await request.text();
    if (rawBody.length > 100_000) return NextResponse.json({ success: false }, { status: 413 });
    body = JSON.parse(rawBody) as unknown;
  } catch {
    return NextResponse.json({ success: false }, { status: 400 });
  }

  if (!isRecord(body) || body.event !== "sale.sync" || !isRecord(body.data)) {
    return NextResponse.json({ success: false }, { status: 400 });
  }
  const data = body.data;
  const queueStatus = typeof data.queue_status === "string" ? data.queue_status.toLowerCase() : "";
  const responseData = JSON.stringify(body);
  const callbackTokenHash = createHash("sha256").update(token).digest("hex");

  let status: "pending" | "submitted" | "failed" | "unknown";
  let errorMessage: string | null = null;
  if (queueStatus === "completed") {
    const invoiceNumber = data.invoice_number;
    const signature = data.receipt_signature;
    const verificationUrl = safeHttpsUrl(data.etims_url);
    if (invoiceNumber !== undefined && invoiceNumber !== null && signature && verificationUrl) {
      status = "submitted";
    } else {
      status = "unknown";
      errorMessage = "DigiTax completed the sale but the callback did not include all signed receipt details.";
    }
  } else if (queueStatus === "failed") {
    status = "failed";
    const failure = typeof data.kra_response_message === "string" ? data.kra_response_message
      : typeof data.message === "string" ? data.message
        : "DigiTax reports that KRA failed this sale.";
    errorMessage = `DigiTax sale sync failed: ${failure.slice(0, 500)}`;
  } else if (queueStatus === "pending") {
    status = "pending";
    errorMessage = "DigiTax has queued the sale; eTIMS synchronization is still pending.";
  } else {
    status = "unknown";
    errorMessage = "DigiTax sent an unrecognized sale.sync status. Verify the sale in DigiTax.";
  }

  const invoiceNumber = data.invoice_number === undefined || data.invoice_number === null
    ? null
    : String(data.invoice_number);
  const receiptNumber = data.receipt_number === undefined || data.receipt_number === null
    ? null
    : String(data.receipt_number);
  const receiptDate = typeof data.date === "string" ? data.date : null;
  const signature = typeof data.receipt_signature === "string" ? data.receipt_signature : null;
  const verificationUrl = safeHttpsUrl(data.etims_url);
  const providerReference = typeof data.digitax_id === "string" ? data.digitax_id
    : typeof data.id === "string" ? data.id
      : null;

  try {
    const updated = await query(
      `UPDATE etims_submissions
       SET status = $2, error_message = $3, provider_response = $4::jsonb,
           provider_reference = COALESCE($5, provider_reference),
           invoice_number = COALESCE($6, invoice_number),
           invoice_signature = COALESCE($7, invoice_signature),
           scu_receipt_date = COALESCE($8, scu_receipt_date),
           scu_receipt_number = COALESCE($9, scu_receipt_number),
           verification_url = COALESCE($10, verification_url),
           updated_at = NOW()
       WHERE provider = 'digitax' AND callback_token_hash = $1
         AND status <> 'submitted'
         AND NOT (status = 'failed' AND $2 = 'pending')
       RETURNING id`,
      [callbackTokenHash, status, errorMessage, responseData, providerReference,
        invoiceNumber, signature, receiptDate, receiptNumber, verificationUrl],
    );
    if (updated.rowCount) return NextResponse.json({ success: true });

    const existing = await query<{ status: string }>(
      `SELECT status FROM etims_submissions
       WHERE provider = 'digitax' AND callback_token_hash = $1`,
      [callbackTokenHash],
    );
    if (existing.rows[0]?.status === "submitted") return NextResponse.json({ success: true });
    return NextResponse.json({ success: false }, { status: 404 });
  } catch (error) {
    console.error("Unable to process DigiTax sale callback.", error);
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
