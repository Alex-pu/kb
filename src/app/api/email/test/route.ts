import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/require-session";
import { databaseReady } from "@/lib/db/postgres";
import { loadPropertySmtpConfig } from "@/lib/email/property-config";
import { canManagePropertyEmail, PROPERTY_ID_PATTERN } from "@/lib/email/property-access";
import { sendSmtpMail } from "@/lib/email/smtp";

export const runtime = "nodejs";

function validEmail(value: string) {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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
  const recipient = typeof body.recipient === "string" ? body.recipient.trim().toLowerCase() : "";
  if (!PROPERTY_ID_PATTERN.test(propertyId)) {
    return NextResponse.json({ success: false, message: "A valid property is required." }, { status: 400 });
  }
  if (!canManagePropertyEmail(auth.bundle, propertyId)) {
    return NextResponse.json({ success: false, message: "You do not have permission to test email settings for this property." }, { status: 403 });
  }
  if (!validEmail(recipient)) {
    return NextResponse.json({ success: false, message: "Enter a valid test recipient email address." }, { status: 400 });
  }

  let config;
  try {
    config = await loadPropertySmtpConfig(auth.userId, propertyId);
  } catch (error) {
    console.error("Failed to load SMTP settings for test email.", error);
    return NextResponse.json({ success: false, message: "Saved SMTP settings could not be read. Re-enter the SMTP password." }, { status: 503 });
  }
  if (!config) {
    return NextResponse.json({ success: false, message: "Save this property's SMTP settings before sending a test email." }, { status: 400 });
  }

  const propertyName = auth.bundle.properties.find((property) => property.id === propertyId)?.name ?? "Property";
  try {
    await sendSmtpMail(config, {
      from: { name: propertyName, address: config.fromAddress },
      to: recipient,
      subject: `${propertyName} email configuration test`,
      text: `This is a test email from ${propertyName}. The configured SMTP settings are working.`,
    });
    return NextResponse.json({ success: true, message: `Test email sent to ${recipient}.` });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
    console.error("Property SMTP test email failed.", { code });
    return NextResponse.json({ success: false, message: "The test email could not be sent. Check the SMTP host, port, username, password, and mailbox sending limits." }, { status: 502 });
  }
}
