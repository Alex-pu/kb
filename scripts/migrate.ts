/**
 * Plain-Postgres migration runner (replaces `supabase db push`).
 * Applies every .sql file in db/migrations, in filename order, that hasn't
 * been applied yet, tracked in a `schema_migrations` table.
 *
 * Usage: npm run db:migrate
 */
import { config as loadEnv } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";

loadEnv({ path: path.resolve(process.cwd(), ".env.local") });
loadEnv(); // fall back to .env if present

const MIGRATIONS_DIR = path.resolve(process.cwd(), "db", "migrations");

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
    console.error("DATABASE_URL (or POSTGRES_URL) is not set. Add it to .env.local before running migrations.");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString,
    ssl: requiresSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
  });

  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    if (files.length === 0) {
      console.log("No migration files found in db/migrations.");
      return;
    }

    const { rows: applied } = await client.query<{ filename: string }>("SELECT filename FROM schema_migrations");
    const appliedSet = new Set(applied.map((r) => r.filename));

    let appliedCount = 0;
    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`skip  ${file} (already applied)`);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      console.log(`apply ${file} ...`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
        await client.query("COMMIT");
        appliedCount += 1;
        console.log(`  done: ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        console.error(`  failed on ${file}`);
        throw error;
      }
    }

    console.log(appliedCount > 0 ? `Done. Applied ${appliedCount} migration(s).` : "Database already up to date.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
