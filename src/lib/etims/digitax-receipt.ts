export interface DigitaxReceiptDetails {
  invoiceNumber: string | null;
  receiptNumber: string | null;
  receiptDate: string | null;
  signature: string | null;
  verificationUrl: string | null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  return normalized || null;
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

export function parseDigitaxReceiptDetails(data: Record<string, unknown>): DigitaxReceiptDetails {
  return {
    invoiceNumber: nonEmptyString(data.invoice_number),
    receiptNumber: nonEmptyString(data.receipt_number),
    receiptDate: typeof data.date === "string" ? data.date : null,
    signature: nonEmptyString(data.receipt_signature),
    verificationUrl: safeHttpsUrl(data.etims_url),
  };
}

export function hasSignedDigitaxReceipt(details: DigitaxReceiptDetails): boolean {
  return Boolean(details.invoiceNumber && details.signature && details.verificationUrl);
}
