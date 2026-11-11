/**
 * Resets the password for an existing platform super-admin without changing
 * the account or creating another one. Run from an interactive terminal.
 */
import { config as loadEnv } from "dotenv";
import path from "node:path";
import readline from "node:readline/promises";
import bcrypt from "bcryptjs";
import { Pool } from "pg";
import { askConfirmedPassword } from "./password-prompt";

loadEnv({ path: path.resolve(process.cwd(), ".env.local") });
loadEnv();

function requiresSsl(connectionString: string) {
  if (/sslmode=require|sslmode=verify/i.test(connectionString)) return true;
  try {
    const host = new URL(connectionString).hostname;
    return host !== "localhost" && host !== "127.0.0.1";
  } catch {
    return false;
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL (or POSTGRES_URL) is not set. Add it to .env.local first.");
  }

  const pool = new Pool({
    connectionString,
    ssl: requiresSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
  });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const email = (await rl.question("Existing super-admin email: ")).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) {
      throw new Error("Enter the valid email address for the existing super-admin.");
    }

    const { rows: [admin] } = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE lower(email) = $1 AND is_super_admin = TRUE AND is_active = TRUE`,
      [email],
    );
    if (!admin) throw new Error("No active platform super-admin was found with that email.");

    const confirmation = (await rl.question(`Type RESET to change the password for ${email}: `)).trim();
    if (confirmation !== "RESET") {
      console.log("Cancelled. No changes were made.");
      return;
    }
    rl.close();

    const password = await askConfirmedPassword("New password");
    const passwordHash = await bcrypt.hash(password, 12);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: [lockedAdmin] } = await client.query<{ id: string; company_id: string }>(
        `SELECT id, company_id FROM users
         WHERE id = $1 AND is_super_admin = TRUE AND is_active = TRUE
         FOR UPDATE`,
        [admin.id],
      );
      if (!lockedAdmin) throw new Error("The super-admin account is no longer active; no changes were made.");

      await client.query(
        `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
        [passwordHash, lockedAdmin.id],
      );
      const revoked = await client.query<{ id: string }>(
        `UPDATE sessions SET revoked_at = NOW()
         WHERE user_id = $1 AND revoked_at IS NULL
         RETURNING id`,
        [lockedAdmin.id],
      );
      if (revoked.rows.length > 0) {
        await client.query(
          `DELETE FROM cashier_outlet_sessions
           WHERE user_id = $1 AND session_id = ANY($2::uuid[])`,
          [lockedAdmin.id, revoked.rows.map((session) => session.id)],
        );
      }
      await client.query(
        `INSERT INTO audit_log (company_id, actor_user_id, action_type, resource_type, resource_id, payload_after)
         VALUES ($1, NULL, 'PLATFORM.SUPER_ADMIN_PASSWORD_RESET', 'users', $2, $3::jsonb)`,
        [lockedAdmin.company_id, lockedAdmin.id, JSON.stringify({ reset_via: "interactive_cli" })],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    console.log("Super-admin password updated. Sign in with the new password.");
  } finally {
    rl.close();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Password reset failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
