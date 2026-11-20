import "server-only";
import type { QueryResultRow } from "pg";
import { query } from "@/lib/db/postgres";
import { decryptSecret } from "@/lib/supabase/secret-crypto";
import type { SmtpCredentials } from "@/lib/email/smtp";

interface PlatformEmailConfigRow extends QueryResultRow {
  smtp_host: string;
  smtp_port: 465 | 587;
  smtp_username: string;
  from_address: string;
  notification_recipient: string;
  password_encrypted: string;
}

export interface PlatformSmtpConfig extends SmtpCredentials {
  fromAddress: string;
  notificationRecipient: string;
}

export async function loadPlatformSmtpConfig(): Promise<PlatformSmtpConfig | null> {
  const result = await query<PlatformEmailConfigRow>(
    `SELECT smtp_host, smtp_port, smtp_username, from_address, notification_recipient, password_encrypted
     FROM platform_email_config
     WHERE id = 1`,
  );
  const config = result.rows[0];
  if (!config) return null;

  try {
    return {
      host: config.smtp_host,
      port: config.smtp_port,
      username: config.smtp_username,
      fromAddress: config.from_address,
      notificationRecipient: config.notification_recipient,
      password: decryptSecret(config.password_encrypted),
    };
  } catch (error) {
    console.error("Unable to decrypt platform SMTP credentials.", error);
    throw new Error("The platform SMTP password could not be decrypted.");
  }
}
