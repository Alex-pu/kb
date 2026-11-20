import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/require-session";
import { databaseReady } from "@/lib/db/postgres";
import { loadPlatformSmtpConfig } from "@/lib/email/platform-config";
import { sendSmtpMail } from "@/lib/email/smtp";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });
  if (!auth.bundle.user.is_super_admin) return NextResponse.json({ success: false, message: "Only a platform super admin can test platform email." }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return NextResponse.json({ success: false, message: "Request body must be a JSON object." }, { status: 400 });
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ success: false, message: "Request body must be valid JSON." }, { status: 400 });
  }

  const recipient = typeof body.recipient === "string" ? body.recipient.trim().toLowerCase() : "";
  if (!recipient || recipient.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    return NextResponse.json({ success: false, message: "Enter a valid test recipient email address." }, { status: 400 });
  }

  try {
    const config = await loadPlatformSmtpConfig();
    if (!config) return NextResponse.json({ success: false, message: "Save platform email settings before sending a test email." }, { status: 400 });
    await sendSmtpMail(config, {
      from: { name: "Kore Bench", address: config.fromAddress },
      to: recipient,
      subject: "Kore Bench platform email configuration test",
      text: "This is a test email from the Kore Bench platform. The SMTP settings are working.",
    });
    return NextResponse.json({ success: true, message: `Test email sent to ${recipient}.` });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
    console.error("Platform SMTP test email failed.", { code });
    return NextResponse.json({ success: false, message: "The test email could not be sent. Check the SMTP host, port, username, password, and mailbox sending limits." }, { status: 502 });
  }
}
