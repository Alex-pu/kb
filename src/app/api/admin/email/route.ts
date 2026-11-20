import { NextResponse } from "next/server";
import type { QueryResultRow } from "pg";
import { getAuthContext } from "@/lib/auth/require-session";
import { databaseReady, query } from "@/lib/db/postgres";
import { encryptSecret } from "@/lib/supabase/secret-crypto";

export const runtime = "nodejs";

interface PlatformEmailRow extends QueryResultRow {
  smtp_host: string;
  smtp_port: number;
  smtp_username: string;
  from_address: string;
  notification_recipient: string;
  password_encrypted: string;
}

function validEmail(value: string) {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validHost(value: string) {
  return value.length <= 253 &&
    /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/.test(value) &&
    !value.toLowerCase().endsWith(".local");
}

export async function GET() {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });
  if (!auth.bundle.user.is_super_admin) return NextResponse.json({ success: false, message: "Only a platform super admin can manage platform email." }, { status: 403 });

  const result = await query<PlatformEmailRow>(
    `SELECT smtp_host, smtp_port, smtp_username, from_address, notification_recipient, password_encrypted
     FROM platform_email_config WHERE id = 1`,
  );
  const config = result.rows[0];
  return NextResponse.json({
    success: true,
    config: config ? {
      smtp_host: config.smtp_host,
      smtp_port: config.smtp_port,
      smtp_username: config.smtp_username,
      from_address: config.from_address,
      notification_recipient: config.notification_recipient,
      has_password: Boolean(config.password_encrypted),
    } : {
      smtp_host: "",
      smtp_port: 465,
      smtp_username: "",
      from_address: "",
      notification_recipient: "kamaua175@gmail.com",
      has_password: false,
    },
  });
}

export async function PATCH(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });
  if (!auth.bundle.user.is_super_admin) return NextResponse.json({ success: false, message: "Only a platform super admin can manage platform email." }, { status: 403 });

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

  const host = typeof body.smtp_host === "string" ? body.smtp_host.trim().toLowerCase() : "";
  const port = body.smtp_port;
  const username = typeof body.smtp_username === "string" ? body.smtp_username.trim().toLowerCase() : "";
  const fromAddress = typeof body.from_address === "string" ? body.from_address.trim().toLowerCase() : "";
  const recipient = typeof body.notification_recipient === "string" ? body.notification_recipient.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!validHost(host) || (port !== 465 && port !== 587) ||
      !validEmail(username) || !validEmail(fromAddress) || !validEmail(recipient) ||
      password.length > 1024 || /[\r\n\0]/.test(password)) {
    return NextResponse.json({ success: false, message: "Enter valid SMTP host, port, username, sender, recipient, and password details." }, { status: 400 });
  }

  try {
    const existing = await query<PlatformEmailRow>(`SELECT password_encrypted FROM platform_email_config WHERE id = 1`);
    if (!password && !existing.rows[0]?.password_encrypted) {
      return NextResponse.json({ success: false, message: "Enter the SMTP mailbox password before saving." }, { status: 400 });
    }

    let encryptedPassword: string | null = null;
    if (password) {
      try {
        encryptedPassword = encryptSecret(password);
      } catch (error) {
        console.error("Unable to encrypt platform SMTP password.", error);
        return NextResponse.json({ success: false, message: "The server credential encryption key must be configured before saving the SMTP password." }, { status: 503 });
      }
    }

    await query(
      `INSERT INTO platform_email_config
         (id, smtp_host, smtp_port, smtp_username, from_address, notification_recipient, password_encrypted, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (id) DO UPDATE SET
         smtp_host = EXCLUDED.smtp_host,
         smtp_port = EXCLUDED.smtp_port,
         smtp_username = EXCLUDED.smtp_username,
         from_address = EXCLUDED.from_address,
         notification_recipient = EXCLUDED.notification_recipient,
         password_encrypted = COALESCE(EXCLUDED.password_encrypted, platform_email_config.password_encrypted),
         updated_at = NOW()`,
      [host, port, username, fromAddress, recipient, encryptedPassword],
    );
    return NextResponse.json({ success: true, message: "Platform email settings saved securely.", has_password: true });
  } catch (error) {
    console.error("Failed to save platform email settings.", error);
    return NextResponse.json({ success: false, message: "Email settings could not be saved. Confirm the database migrations and server database connection." }, { status: 500 });
  }
}
