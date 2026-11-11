import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/require-session";
import { databaseReady, getPool } from "@/lib/db/postgres";

export const runtime = "nodejs";

const PROPERTY_TYPES = ["hotel", "restaurant", "retail", "hybrid"] as const;
const OUTLET_TYPES = ["retail_counter", "restaurant", "bar", "front_desk", "kitchen", "store"] as const;
const STATION_TYPES = ["pos_till", "kds_screen", "reception_terminal", "store_terminal"] as const;

interface PropertyRequest {
  company_name?: unknown;
  tax_pin?: unknown;
  country_code?: unknown;
  currency?: unknown;
  property_name?: unknown;
  property_code?: unknown;
  property_type?: unknown;
  property_address?: unknown;
  property_phone?: unknown;
  property_email?: unknown;
  outlet_name?: unknown;
  outlet_code?: unknown;
  outlet_type?: unknown;
  station_name?: unknown;
  station_type?: unknown;
  admin_name?: unknown;
  admin_email?: unknown;
  admin_phone?: unknown;
  admin_password?: unknown;
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "23505";
}

export async function POST(request: Request) {
  if (!databaseReady()) {
    return NextResponse.json({ success: false, message: "DATABASE_URL is not configured on the server." }, { status: 503 });
  }

  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });
  if (!auth.bundle.user.is_super_admin) {
    return NextResponse.json({ success: false, message: "Only a platform super admin can create properties." }, { status: 403 });
  }

  let body: PropertyRequest;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return NextResponse.json({ success: false, message: "Request body must be a JSON object." }, { status: 400 });
    }
    body = parsed as PropertyRequest;
  } catch {
    return NextResponse.json({ success: false, message: "Request body must be valid JSON." }, { status: 400 });
  }

  const companyName = trimmed(body.company_name);
  const taxPin = trimmed(body.tax_pin);
  const countryCode = trimmed(body.country_code).toUpperCase();
  const currency = trimmed(body.currency).toUpperCase();
  const propertyName = trimmed(body.property_name);
  const propertyCode = trimmed(body.property_code).toUpperCase();
  const propertyType = trimmed(body.property_type);
  const propertyAddress = trimmed(body.property_address);
  const propertyPhone = trimmed(body.property_phone);
  const propertyEmail = trimmed(body.property_email).toLowerCase();
  const outletName = trimmed(body.outlet_name);
  const outletCode = trimmed(body.outlet_code).toUpperCase();
  const outletType = trimmed(body.outlet_type);
  const stationName = trimmed(body.station_name);
  const stationType = trimmed(body.station_type);
  const adminName = trimmed(body.admin_name);
  const adminEmail = trimmed(body.admin_email).toLowerCase();
  const adminPhone = trimmed(body.admin_phone);
  const adminPassword = typeof body.admin_password === "string" ? body.admin_password : "";

  if (!companyName || companyName.length > 255 ||
      taxPin.length > 50 ||
      !/^[A-Z]{2}$/.test(countryCode) ||
      !/^[A-Z]{3}$/.test(currency) ||
      !propertyName || propertyName.length > 255 ||
      !propertyCode || propertyCode.length > 50 ||
      !PROPERTY_TYPES.includes(propertyType as (typeof PROPERTY_TYPES)[number]) ||
      propertyAddress.length > 2000 ||
      propertyPhone.length > 50 ||
      (propertyEmail && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(propertyEmail) || propertyEmail.length > 255)) ||
      !outletName || outletName.length > 255 ||
      !outletCode || outletCode.length > 50 ||
      !OUTLET_TYPES.includes(outletType as (typeof OUTLET_TYPES)[number]) ||
      !stationName || stationName.length > 255 ||
      !STATION_TYPES.includes(stationType as (typeof STATION_TYPES)[number]) ||
      !adminName || adminName.length > 255 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail) || adminEmail.length > 255 ||
      adminPhone.length > 50 ||
      adminPassword.length < 12 || adminPassword.length > 128) {
    return NextResponse.json({
      success: false,
      message: "Check the company, property, outlet, and administrator details. Passwords must be 12–128 characters.",
    }, { status: 400 });
  }

  const pool = getPool();
  if (!pool) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });

  const passwordHash = await bcrypt.hash(adminPassword, 12);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: [company] } = await client.query<{ id: string }>(
      `INSERT INTO companies (name, tax_pin, country_code, currency)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [companyName, taxPin || null, countryCode, currency],
    );
    const { rows: [property] } = await client.query<{ id: string }>(
      `INSERT INTO properties (company_id, name, code, property_type, physical_address, phone_number, email)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [company.id, propertyName, propertyCode, propertyType, propertyAddress || null, propertyPhone || null, propertyEmail || null],
    );
    const { rows: [outlet] } = await client.query<{ id: string }>(
      `INSERT INTO outlets (property_id, name, code, outlet_type)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [property.id, outletName, outletCode, outletType],
    );
    await client.query(
      `INSERT INTO stations (outlet_id, name, station_type)
       VALUES ($1, $2, $3)`,
      [outlet.id, stationName, stationType],
    );
    const { rows: [managerRole] } = await client.query<{ id: string }>(
      `INSERT INTO roles (company_id, name, role_key, description, permissions, is_system_role)
       VALUES ($1, 'General Manager / Director', 'general_manager', 'Full property oversight', '["*"]'::jsonb, TRUE)
       RETURNING id`,
      [company.id],
    );
    const { rows: [cashierRole] } = await client.query<{ id: string }>(
      `INSERT INTO roles (company_id, name, role_key, description, permissions, is_system_role)
       VALUES ($1, 'Cashier', 'cashier', 'Open and close cashier shifts and clear restaurant and bar bills',
               '["pos:read", "shift:open", "shift:close", "restaurant:read", "restaurant:settle"]'::jsonb, TRUE)
       RETURNING id`,
      [company.id],
    );
    await client.query(
      `INSERT INTO roles (company_id, name, role_key, description, permissions, is_system_role)
       VALUES ($1, 'Waiter', 'waiter', 'Create restaurant orders and follow their payment status',
               '["restaurant:read", "restaurant:write"]'::jsonb, TRUE)`,
      [company.id],
    );
    const { rows: [admin] } = await client.query<{ id: string }>(
      `INSERT INTO users (company_id, full_name, email, phone_number, password_hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [company.id, adminName, adminEmail, adminPhone || null, passwordHash],
    );
    await client.query(
      `INSERT INTO user_assignments (user_id, property_id, outlet_id, role_id, can_override_approval)
       VALUES ($1, $2, $3, $4, TRUE)`,
      [admin.id, property.id, outlet.id, managerRole.id],
    );
    await client.query(
      `INSERT INTO audit_log (company_id, actor_user_id, action_type, resource_type, resource_id, payload_after)
       VALUES ($1, $2, 'PLATFORM.PROPERTY_CREATE', 'properties', $3, $4::jsonb)`,
      [company.id, auth.userId, property.id, JSON.stringify({ company_id: company.id, admin_user_id: admin.id })],
    );

    await client.query("COMMIT");
    return NextResponse.json({
      success: true,
      message: `${propertyName} was created with an initial property administrator.`,
      property_id: property.id,
      admin_email: adminEmail,
    }, { status: 201 });
  } catch (error) {
    await client.query("ROLLBACK");
    if (isUniqueViolation(error)) {
      return NextResponse.json({
        success: false,
        message: "That administrator email or property/outlet code is already in use.",
      }, { status: 409 });
    }
    console.error("Failed to create a property from the platform admin workspace.", error);
    return NextResponse.json({ success: false, message: "Property creation failed. No changes were saved." }, { status: 500 });
  } finally {
    client.release();
  }
}
