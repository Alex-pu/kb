import { NextResponse } from "next/server";
import type { QueryResultRow } from "pg";
import { getAuthContext } from "@/lib/auth/require-session";
import { databaseReady, withUserContext } from "@/lib/db/postgres";
import { encryptSecret } from "@/lib/supabase/secret-crypto";
import { canManagePropertyEmail, PROPERTY_ID_PATTERN } from "@/lib/email/property-access";

export const runtime = "nodejs";

interface EmailConfigRow extends QueryResultRow {
  smtp_host: string;
  smtp_port: number;
  smtp_username: string;
  from_address: string;
  password_encrypted: string;
}

function validEmail(value: string) {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validSmtpHost(value: string) {
  return value.length <= 253 &&
    /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/.test(value) &&
    !value.toLowerCase().endsWith(".local");
}

async function authorizeProperty(propertyId: string) {
  if (!PROPERTY_ID_PATTERN.test(propertyId)) {
    return { response: NextResponse.json({ success: false, message: "A valid property is required." }, { status: 400 }) };
  }
  const auth = await getAuthContext();
  if (!auth) {
    return { response: NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 }) };
  }
  if (!canManagePropertyEmail(auth.bundle, propertyId)) {
    return { response: NextResponse.json({ success: false, message: "You do not have permission to manage email settings for this property." }, { status: 403 }) };
  }
  return { auth };
}

export async function GET(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const propertyId = new URL(request.url).searchParams.get("property_id") ?? "";
  const access = await authorizeProperty(propertyId);
  if ("response" in access) return access.response;

  try {
    const result = await withUserContext(access.auth.userId, (run) => run<EmailConfigRow>(
      `SELECT smtp_host, smtp_port, smtp_username, from_address, password_encrypted
       FROM property_email_configs
       WHERE property_id = $1`,
      [propertyId],
    ));
    const config = result.rows[0];
    return NextResponse.json({
      success: true,
      config: config ? {
        smtp_host: config.smtp_host,
        smtp_port: config.smtp_port,
        smtp_username: config.smtp_username,
        from_address: config.from_address,
        has_password: Boolean(config.password_encrypted),
      } : {
        smtp_host: "",
        smtp_port: 465,
        smtp_username: "",
        from_address: "",
        has_password: false,
      },
    });
  } catch (error) {
    console.error("Failed to load property email settings.", error);
    return NextResponse.json({ success: false, message: "Email settings could not be loaded." }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
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
  const access = await authorizeProperty(propertyId);
  if ("response" in access) return access.response;

  const host = typeof body.smtp_host === "string" ? body.smtp_host.trim().toLowerCase() : "";
  const port = body.smtp_port;
  const username = typeof body.smtp_username === "string" ? body.smtp_username.trim().toLowerCase() : "";
  const fromAddress = typeof body.from_address === "string" ? body.from_address.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!validSmtpHost(host) || (port !== 465 && port !== 587) ||
      !validEmail(username) || !validEmail(fromAddress) || password.length > 1024 ||
      /[\r\n\0]/.test(password)) {
    return NextResponse.json({ success: false, message: "Enter a valid SMTP hostname, port (465 or 587), username, sender email, and password." }, { status: 400 });
  }

  try {
    const savedConfig = await withUserContext(access.auth.userId, (run) => run<{ password_encrypted: string | null }>(
      `SELECT password_encrypted FROM property_email_configs WHERE property_id = $1`,
      [propertyId],
    ));
    if (!password && !savedConfig.rows[0]?.password_encrypted) {
      return NextResponse.json({ success: false, message: "Enter the SMTP mailbox password before saving." }, { status: 400 });
    }

    let encryptedPassword: string | null = null;
    if (password) {
      try {
        encryptedPassword = encryptSecret(password);
      } catch (error) {
        console.error("Unable to encrypt property SMTP password.", error);
        return NextResponse.json({ success: false, message: "The server credential encryption key must be configured before saving the SMTP password." }, { status: 503 });
      }
    }

    await withUserContext(access.auth.userId, (run) => run(
      `INSERT INTO property_email_configs
         (property_id, smtp_host, smtp_port, smtp_username, from_address, password_encrypted, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (property_id) DO UPDATE SET
         smtp_host = EXCLUDED.smtp_host,
         smtp_port = EXCLUDED.smtp_port,
         smtp_username = EXCLUDED.smtp_username,
         from_address = EXCLUDED.from_address,
         password_encrypted = COALESCE(EXCLUDED.password_encrypted, property_email_configs.password_encrypted),
         updated_at = NOW()`,
      [propertyId, host, port, username, fromAddress, encryptedPassword],
    ));

    return NextResponse.json({ success: true, message: "Property email settings saved securely.", has_password: true });
  } catch (error) {
    console.error("Failed to save property email settings.", error);
    return NextResponse.json({ success: false, message: "Email settings could not be saved." }, { status: 500 });
  }
}
