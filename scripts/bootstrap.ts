/**
 * Interactive bootstrap for a brand-new, empty database.
 * Creates your real company, one property, one outlet, one POS station,
 * the General Manager and Cashier roles, and an admin user — no placeholder
 * data. Run this once after `npm run db:migrate` against an empty database.
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

function requiresSsl(connectionString: string) {
  if (/sslmode=require|sslmode=verify/i.test(connectionString)) return true;
  try {
    const host = new URL(connectionString).hostname;
    return host !== "localhost" && host !== "127.0.0.1";
  } catch {
    return false;
  }
}

async function ask(rl: readline.Interface, question: string, fallback?: string): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || fallback || "";
}

async function askRequired(rl: readline.Interface, question: string): Promise<string> {
  for (;;) {
    const answer = (await rl.question(`${question}: `)).trim();
    if (answer) return answer;
    console.log("This value is required.");
  }
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
    const { rows: existingCompanies } = await pool.query("SELECT COUNT(*)::int AS count FROM companies");
    if (existingCompanies[0].count > 0) {
      const proceed = await ask(rl, "Companies already exist in this database. Continue and add another company anyway? (y/N)", "N");
      if (proceed.toLowerCase() !== "y") {
        console.log("Aborted — no changes made.");
        return;
      }
    }

    console.log("\n== Company ==");
    const companyName = await askRequired(rl, "Company name");
    const taxPin = await ask(rl, "KRA PIN (optional)", "");
    const currency = await ask(rl, "Currency code", "KES");

    console.log("\n== Property (your first hotel/restaurant/shop) ==");
    const propertyName = await askRequired(rl, "Property name");
    const propertyCode = await askRequired(rl, "Property code (short, unique, e.g. MAIN)");
    let propertyType = "";
    while (!["hotel", "restaurant", "retail", "hybrid"].includes(propertyType)) {
      propertyType = await ask(rl, "Property type (hotel/restaurant/retail/hybrid)", "retail");
    }
    const propertyAddress = await ask(rl, "Physical address (optional)", "");
    const propertyPhone = await ask(rl, "Property phone (optional)", "");
    const propertyEmail = await ask(rl, "Property email (optional)", "");

    console.log("\n== Outlet (the counter/till area within the property) ==");
    const outletName = await askRequired(rl, "Outlet name");
    const outletCode = await askRequired(rl, "Outlet code (short, unique, e.g. POS-01)");
    let outletType = "";
    while (!["retail_counter", "restaurant", "bar", "front_desk", "kitchen", "store"].includes(outletType)) {
      outletType = await ask(rl, "Outlet type (retail_counter/restaurant/bar/front_desk/kitchen/store)", "retail_counter");
    }

    console.log("\n== Station (the physical till) ==");
    const stationName = await askRequired(rl, "Station name (e.g. Till 1)");
    const hardwareId = await ask(rl, "Hardware identifier (optional)", "");

    console.log("\n== Admin user ==");
    const adminName = await askRequired(rl, "Admin full name");
    const adminEmail = await askRequired(rl, "Admin email");
    const adminPhone = await ask(rl, "Admin phone (optional)", "");
    const adminPassword = await askRequired(rl, "Admin password (min 8 characters)");
    if (adminPassword.length < 8) throw new Error("Admin password must be at least 8 characters.");

    console.log("\n== Cashier user (optional — leave blank to skip) ==");
    const cashierName = await ask(rl, "Cashier full name (blank to skip)", "");
    let cashierEmail = "";
    let cashierPhone = "";
    let cashierPassword = "";
    if (cashierName) {
      cashierEmail = await askRequired(rl, "Cashier email");
      cashierPhone = await ask(rl, "Cashier phone (optional)", "");
      cashierPassword = await askRequired(rl, "Cashier password (min 8 characters)");
      if (cashierPassword.length < 8) throw new Error("Cashier password must be at least 8 characters.");
    }

    const adminPasswordHash = await bcrypt.hash(adminPassword, 12);
    const cashierPasswordHash = cashierName ? await bcrypt.hash(cashierPassword, 12) : null;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const { rows: [company] } = await client.query<{ id: string }>(
        `INSERT INTO companies (name, tax_pin, currency) VALUES ($1, $2, $3) RETURNING id`,
        [companyName, taxPin || null, currency],
      );

      const { rows: [property] } = await client.query<{ id: string }>(
        `INSERT INTO properties (company_id, name, code, property_type, physical_address, phone_number, email)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [company.id, propertyName, propertyCode, propertyType, propertyAddress || null, propertyPhone || null, propertyEmail || null],
      );

      const { rows: [outlet] } = await client.query<{ id: string }>(
        `INSERT INTO outlets (property_id, name, code, outlet_type) VALUES ($1, $2, $3, $4) RETURNING id`,
        [property.id, outletName, outletCode, outletType],
      );

      const { rows: [station] } = await client.query<{ id: string }>(
        `INSERT INTO stations (outlet_id, name, station_type, hardware_identifier) VALUES ($1, $2, 'pos_till', $3) RETURNING id`,
        [outlet.id, stationName, hardwareId || null],
      );

      const { rows: [gmRole] } = await client.query<{ id: string }>(
        `INSERT INTO roles (company_id, name, role_key, description, permissions, is_system_role)
         VALUES ($1, 'General Manager / Director', 'general_manager', 'Full property oversight', '["*"]'::jsonb, TRUE) RETURNING id`,
        [company.id],
      );

      const { rows: [cashierRole] } = await client.query<{ id: string }>(
        `INSERT INTO roles (company_id, name, role_key, description, permissions, is_system_role)
         VALUES ($1, 'Cashier', 'cashier', 'Open and close cashier shifts and clear restaurant and bar bills',
                 '["pos:read", "shift:open", "shift:close", "restaurant:read", "restaurant:settle"]'::jsonb, TRUE) RETURNING id`,
        [company.id],
      );

      await client.query(
        `INSERT INTO roles (company_id, name, role_key, description, permissions, is_system_role)
         VALUES ($1, 'Waiter', 'waiter', 'Create restaurant orders and follow their payment status',
                 '["restaurant:read", "restaurant:write"]'::jsonb, TRUE)`,
        [company.id],
      );

      const { rows: [adminUser] } = await client.query<{ id: string }>(
        `INSERT INTO users (company_id, full_name, email, phone_number, password_hash)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [company.id, adminName, adminEmail, adminPhone || null, adminPasswordHash],
      );

      await client.query(
        `INSERT INTO user_assignments (user_id, property_id, outlet_id, role_id, can_override_approval)
         VALUES ($1, $2, $3, $4, TRUE)`,
        [adminUser.id, property.id, outlet.id, gmRole.id],
      );

      if (cashierName && cashierPasswordHash) {
        const { rows: [cashierUser] } = await client.query<{ id: string }>(
          `INSERT INTO users (company_id, full_name, email, phone_number, password_hash)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [company.id, cashierName, cashierEmail, cashierPhone || null, cashierPasswordHash],
        );
        await client.query(
          `INSERT INTO user_assignments (user_id, property_id, outlet_id, station_id, role_id, can_override_approval)
           VALUES ($1, $2, $3, $4, $5, FALSE)`,
          [cashierUser.id, property.id, outlet.id, station.id, cashierRole.id],
        );
      }

      await client.query("COMMIT");
      console.log("\nBootstrap complete. You can now log in with the admin account you just created.");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    rl.close();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("\nBootstrap failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
