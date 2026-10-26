import "server-only";
import { Pool, type QueryResult, type QueryResultRow } from "pg";

let pool: Pool | null = null;

function requiresSsl(connectionString: string) {
  // Neon (and most managed Postgres hosts) require TLS; local/dev databases usually don't.
  if (/sslmode=require|sslmode=verify/i.test(connectionString)) return true;
  try {
    const host = new URL(connectionString).hostname;
    return host !== "localhost" && host !== "127.0.0.1" && !host.endsWith(".internal");
  } catch {
    return false;
  }
}

export function getPool() {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!connectionString) return null;

  pool ??= new Pool({
    connectionString,
    max: Number(process.env.POSTGRES_POOL_SIZE || 10),
    idleTimeoutMillis: 30_000,
    // node-postgres does not honor `sslmode=require` in the URL on its own;
    // it needs an explicit ssl config. Neon's certificate chain validates fine,
    // but `rejectUnauthorized: false` keeps this resilient across managed hosts
    // whose intermediate CAs aren't always in Node's default trust store.
    ssl: requiresSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
  });

  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<T>> {
  const db = getPool();
  if (!db) throw new Error("DATABASE_URL is not configured.");
  return db.query<T>(text, values);
}

export function databaseReady() {
  return Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

/**
 * Runs `fn` inside a transaction with `app.current_user_id` set as a session-local
 * Postgres GUC, so RLS policies (which key off that variable — see
 * db/migrations/001_initial_multi_tenant_schema.sql) scope every query in `fn` to
 * that user's assigned properties, regardless of what the application code does.
 * Always use this (never the bare `query()` above) for requests made on behalf of
 * a signed-in user.
 */
export async function withUserContext<T>(userId: string, fn: (run: typeof query) => Promise<T>): Promise<T> {
  const db = getPool();
  if (!db) throw new Error("DATABASE_URL is not configured.");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
    const scopedQuery = <R extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) =>
      client.query<R>(text, values);
    const result = await fn(scopedQuery as typeof query);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function localApiAuthorized(request: Request) {
  const token = process.env.LOCAL_API_TOKEN;
  if (!token) return false;
  const received = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return received === token;
}
