/**
 * Creates the first platform super-admin account without seeding a tenant,
 * property, or demo data. Run after `npm run db:migrate`.
 *
 * Usage: npm run db:bootstrap
 */
import { config as loadEnv } from "dotenv";
import path from "node:path";
import readline from "node:readline/promises";
import bcrypt from "bcryptjs";
import { Pool } from "pg";

loadEnv({ path: path.resolve(process.cwd(), ".env.local") });
loadEnv();

const PLATFORM_COMPANY_ID = "00000000-0000-4000-8000-000000000001";

function requiresSsl(connectionString: string) {
  if (/sslmode=require|sslmode=verify/i.test(connectionString)) return true;
  try {
    const host = new URL(connectionString).hostname;
    return host !== "localhost" && host !== "127.0.0.1";
  } catch {
    return false;
  }
}

async function askRequired(rl: readline.Interface, question: string): Promise<string> {
  for (;;) {
    const answer = (await rl.question(`${question}: `)).trim();
    if (answer) return answer;
    console.log("This value is required.");
  }
}

async function askSecret(question: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Run this bootstrap from an interactive terminal so the password can be entered without echo.");
  }

  process.stdout.write(`${question}: `);
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      input.off("data", onData);
      input.setRawMode(false);
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          finish(new Error("Bootstrap cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u0008" || character === "\u007f") {
          value = value.slice(0, -1);
        } else if (character >= " ") {
          value += character;
        }
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function main() {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!connectionString) {
    console.error("DATABASE_URL (or POSTGRES_URL) is not set. Add it to .env.local first.");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString,
    ssl: requiresSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
  });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const { rows: [migration] } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'users'
           AND column_name = 'is_super_admin'
       ) AS exists`,
    );
    if (!migration.exists) throw new Error("Run `npm run db:migrate` before bootstrapping the platform super admin.");

    const { rows: [existingAdmin] } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM users WHERE is_super_admin = TRUE) AS exists`,
    );
    if (existingAdmin.exists) {
      throw new Error("A platform super-admin already exists. Bootstrap will not create another one.");
    }

    console.log("\n== Platform super admin ==");
    const fullName = await askRequired(rl, "Full name");
    if (fullName.length > 255) throw new Error("Full name cannot exceed 255 characters.");
    const email = (await askRequired(rl, "Email")).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) {
      throw new Error("Enter a valid email address (maximum 255 characters).");
    }
    rl.close();
    const password = await askSecret("Password (12–128 characters; input is hidden)");
    if (password.length < 12 || password.length > 128) {
      throw new Error("Password must be between 12 and 128 characters.");
    }

    const { rows: [existingUser] } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM users WHERE lower(email) = $1) AS exists`,
      [email],
    );
    if (existingUser.exists) throw new Error("That email address already belongs to an account.");

    const passwordHash = await bcrypt.hash(password, 12);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: [platformCompany] } = await client.query<{ id: string }>(
        `SELECT id FROM companies WHERE id = $1`,
        [PLATFORM_COMPANY_ID],
      );
      if (!platformCompany) {
        throw new Error("Platform company is missing. Run `npm run db:migrate` before bootstrapping.");
      }
      await client.query(
        `INSERT INTO users (company_id, full_name, email, password_hash, is_super_admin)
         VALUES ($1, $2, $3, $4, TRUE)`,
        [PLATFORM_COMPANY_ID, fullName, email, passwordHash],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    console.log("\nSuper-admin bootstrap complete. Sign in at /login and create your first property from the platform workspace.");
  } finally {
    rl.close();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("\nBootstrap failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
