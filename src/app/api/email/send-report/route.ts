import { NextResponse } from "next/server";
import type { QueryResultRow } from "pg";
import { getAuthContext } from "@/lib/auth/require-session";
import { databaseReady, withUserContext } from "@/lib/db/postgres";
import { loadPropertySmtpConfig } from "@/lib/email/property-config";
import { canSendPropertyReport, PROPERTY_ID_PATTERN } from "@/lib/email/property-access";
import { sendSmtpMail } from "@/lib/email/smtp";

export const runtime = "nodejs";

const REPORT_TITLES: Record<string, string> = {
  sales: "Sales by date",
  staff: "Sales by staff",
  products: "Products and categories",
  payments: "Payment methods",
  shifts: "Shift reconciliation",
  financials: "Financial statements",
  occupancy: "Occupancy",
  kots: "Kitchen tickets",
  stock: "Stock risk",
  purchases: "Purchases",
};
const MAX_RECIPIENTS = 100;
const MAX_PDF_BYTES = 8 * 1024 * 1024;
const UUID_PATTERN = PROPERTY_ID_PATTERN;

interface RecipientRow extends QueryResultRow {
  email: string;
}

export async function POST(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    const value: unknown = await request.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return NextResponse.json({ success: false, message: "Request body must be a JSON object." }, { status: 400 });
    }
    body = value as Record<string, unknown>;
  } catch {
    return NextResponse.json({ success: false, message: "Request body must be valid JSON." }, { status: 400 });
  }

  const propertyId = typeof body.property_id === "string" ? body.property_id : "";
  const reportType = typeof body.report_type === "string" ? body.report_type : "";
  const reportTitle = typeof body.report_title === "string" ? body.report_title.trim() : "";
  const period = typeof body.period === "string" ? body.period.trim() : "";
  const recipientIds = Array.isArray(body.recipient_ids) && body.recipient_ids.every((id) => typeof id === "string")
    ? Array.from(new Set(body.recipient_ids as string[]))
    : [];
  const pdfBase64 = typeof body.pdf_base64 === "string" ? body.pdf_base64 : "";

  if (!PROPERTY_ID_PATTERN.test(propertyId) || !REPORT_TITLES[reportType] ||
      !reportTitle || reportTitle.length > 120 || !period || period.length > 120 ||
      /[\r\n\0]/.test(reportTitle + period) ||
      recipientIds.length === 0 || recipientIds.length > MAX_RECIPIENTS ||
      recipientIds.some((id) => !UUID_PATTERN.test(id))) {
    return NextResponse.json({ success: false, message: "The report, date range, or recipient selection is invalid." }, { status: 400 });
  }
  if (!canSendPropertyReport(auth.bundle, propertyId, reportType)) {
    return NextResponse.json({ success: false, message: "You do not have permission to send this report for the selected property." }, { status: 403 });
  }
  if (pdfBase64.length > Math.ceil(MAX_PDF_BYTES * 4 / 3) + 4 ||
      pdfBase64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(pdfBase64)) {
    return NextResponse.json({ success: false, message: "The PDF attachment is invalid or too large (maximum 8 MB)." }, { status: 400 });
  }
  const pdf = Buffer.from(pdfBase64, "base64");
  if (pdf.length === 0 || pdf.length > MAX_PDF_BYTES || pdf.subarray(0, 5).toString("ascii") !== "%PDF-") {
    return NextResponse.json({ success: false, message: "The PDF attachment is invalid or too large (maximum 8 MB)." }, { status: 400 });
  }

  let recipients: string[];
  try {
    const contacts = await withUserContext(auth.userId, (run) => run<RecipientRow>(
      `SELECT email FROM property_email_contacts
       WHERE property_id = $1 AND id = ANY($2::uuid[])`,
      [propertyId, recipientIds],
    ));
    if (contacts.rows.length !== recipientIds.length) {
      return NextResponse.json({ success: false, message: "One or more selected contacts do not belong to this property." }, { status: 400 });
    }
    recipients = contacts.rows.map((contact) => contact.email);
  } catch (error) {
    console.error("Failed to load report email recipients.", error);
    return NextResponse.json({ success: false, message: "The selected email contacts could not be loaded." }, { status: 500 });
  }

  let config;
  try {
    config = await loadPropertySmtpConfig(auth.userId, propertyId);
  } catch (error) {
    console.error("Failed to load SMTP settings for report email.", error);
    return NextResponse.json({ success: false, message: "Saved SMTP settings could not be read. Re-enter the SMTP password." }, { status: 503 });
  }
  if (!config) {
    return NextResponse.json({ success: false, message: "Configure this property's SMTP settings before emailing reports." }, { status: 400 });
  }

  const propertyName = auth.bundle.properties.find((property) => property.id === propertyId)?.name ?? "Property";
  const filePeriod = period.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "report";
  const filename = `${reportType}-${filePeriod}.pdf`;
  try {
    await sendSmtpMail(config, {
      from: { name: propertyName, address: config.fromAddress },
      to: config.fromAddress,
      bcc: recipients,
      subject: `${reportTitle} - ${period}`,
      text: `Attached is the ${reportTitle} report for ${propertyName} (${period}).`,
      attachments: [{ filename, content: pdf, contentType: "application/pdf" }],
    });
    return NextResponse.json({ success: true, message: `PDF report sent to ${recipients.length} contact(s).` });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
    console.error("Property report email delivery failed.", { code, reportType });
    return NextResponse.json({ success: false, message: "The report email could not be sent. Check the property's SMTP settings and mailbox sending limits." }, { status: 502 });
  }
}
