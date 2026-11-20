import { NextResponse } from "next/server";
import { databaseReady, query } from "@/lib/db/postgres";
import { loadPlatformSmtpConfig } from "@/lib/email/platform-config";
import { sendSmtpMail } from "@/lib/email/smtp";

export const runtime = "nodejs";

const LEAD_PLANS = new Set(["hydra", "virgo", "ursa-major", "not-sure"]);

function isValidLocalDateTime(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 16) === value;
}

export async function POST(request: Request) {
  if (!databaseReady()) {
    return NextResponse.json(
      { success: false, message: "Lead requests are temporarily unavailable. Please contact us by phone or email." },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, message: "Request body must be valid JSON." }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ success: false, message: "Request body must be a JSON object." }, { status: 400 });
  }

  const data = body as Record<string, unknown>;
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const organization = typeof data.organization === "string" ? data.organization.trim() : "";
  const email = typeof data.email === "string" ? data.email.trim() : "";
  const phone = typeof data.phone === "string" ? data.phone.trim() : "";
  const plan = typeof data.plan === "string" ? data.plan : "";
  const preferredDemoAt = typeof data.preferredDemoAt === "string" ? data.preferredDemoAt : "";
  const message = typeof data.message === "string" ? data.message.trim() : "";

  if (
    (data.message !== undefined && typeof data.message !== "string") ||
    !name || name.length > 160 ||
    !organization || organization.length > 180 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
    !/^\+?[\d\s().-]{7,30}$/.test(phone) ||
    !LEAD_PLANS.has(plan) ||
    !isValidLocalDateTime(preferredDemoAt) ||
    message.length > 2000
  ) {
    return NextResponse.json(
      { success: false, message: "Please check your name, organization, email, phone, package, and preferred demo date and time." },
      { status: 400 },
    );
  }

  try {
    await query(
      `INSERT INTO marketing_leads
        (full_name, phone, organization, email, plan, preferred_demo_at, message)
       VALUES ($1, $2, $3, $4, $5, $6::timestamp, $7)`,
      [name, phone, organization, email, plan, preferredDemoAt, message || null],
    );
    try {
      const platformEmail = await loadPlatformSmtpConfig();
      if (platformEmail) {
        await sendSmtpMail(platformEmail, {
          from: { name: "Kore Bench Demo Requests", address: platformEmail.fromAddress },
          to: platformEmail.notificationRecipient,
          replyTo: email,
          subject: `New demo request: ${organization}`,
          text: [
            "A new Kore Bench demo request was submitted.",
            "",
            `Name: ${name}`,
            `Organization: ${organization}`,
            `Email: ${email}`,
            `Phone: ${phone}`,
            `Package: ${plan}`,
            `Preferred demo: ${preferredDemoAt}`,
            `Message: ${message || "None"}`,
          ].join("\n"),
        });
      }
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
      console.error("Lead notification email could not be sent.", { code });
    }
    return NextResponse.json({ success: true }, { status: 201 });
  } catch (error) {
    console.error("Could not save a marketing lead.", error);
    return NextResponse.json(
      { success: false, message: "We could not save your request. Please try again or contact us by phone or email." },
      { status: 500 },
    );
  }
}
