import "server-only";
import type { QueryResultRow } from "pg";
import { withUserContext } from "@/lib/db/postgres";
import { decryptSecret } from "@/lib/supabase/secret-crypto";
import type { SmtpCredentials } from "@/lib/email/smtp";

interface EmailConfigRow extends QueryResultRow {
  smtp_host: string;
  smtp_port: 465 | 587;
  smtp_username: string;
  from_address: string;
  password_encrypted: string;
}

export interface PropertySmtpConfig extends SmtpCredentials {
  fromAddress: string;
}

export async function loadPropertySmtpConfig(userId: string, propertyId: string): Promise<PropertySmtpConfig | null> {
  const result = await withUserContext(userId, (run) => run<EmailConfigRow>(
    `SELECT smtp_host, smtp_port, smtp_username, from_address, password_encrypted
     FROM property_email_configs
     WHERE property_id = $1`,
    [propertyId],
  ));
  const config = result.rows[0];
  if (!config) return null;

  try {
    return {
      host: config.smtp_host,
      port: config.smtp_port,
      username: config.smtp_username,
      fromAddress: config.from_address,
      password: decryptSecret(config.password_encrypted),
    };
  } catch (error) {
    console.error("Unable to decrypt property SMTP credentials.", error);
    throw new Error("The property SMTP password could not be decrypted. Re-enter it in Property Settings.");
  }
}
