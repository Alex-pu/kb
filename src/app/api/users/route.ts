import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import type { QueryResultRow } from "pg";
import { getAuthContext, hasPermission } from "@/lib/auth/require-session";
import { permissionGranted } from "@/lib/auth/permissions";
import { databaseReady, withUserContext } from "@/lib/db/postgres";

export const runtime = "nodejs";

interface StaffRow extends QueryResultRow {
  id: string;
  full_name: string;
  email: string | null;
  phone_number: string | null;
  is_active: boolean;
  pin_enabled: boolean;
  account_management_allowed: boolean;
  assignment_id: string;
  property_id: string;
  property_code: string;
  role_name: string;
  role_id: string;
  assignment_active: boolean;
  outlet_id: string | null;
  station_id: string | null;
  max_discount_percent: string;
  max_void_amount: string;
  can_override_approval: boolean;
}

interface UserDirectoryRows {
  staff: StaffRow[];
  properties: { id: string; name: string; code: string }[];
  roles: { id: string; name: string; permissions: string[] }[];
}

interface UserRequestBody {
  full_name?: unknown;
  email?: unknown;
  phone_number?: unknown;
  password?: unknown;
  property_id?: unknown;
  role_id?: unknown;
  assignment_id?: unknown;
  user_id?: unknown;
  action?: unknown;
  outlet_id?: unknown;
  station_id?: unknown;
  max_discount_percent?: unknown;
  max_void_amount?: unknown;
  can_override_approval?: unknown;
  pin?: unknown;
  clear_pin?: unknown;
}

function permissionPropertyIds(
  auth: NonNullable<Awaited<ReturnType<typeof getAuthContext>>>,
  permission: string
) {
  return Array.from(new Set(auth.bundle.assignments
    .filter((assignment) => hasPermission(auth.bundle, assignment.property_id, permission))
    .map((assignment) => assignment.property_id)));
}

function canGrantRole(
  auth: NonNullable<Awaited<ReturnType<typeof getAuthContext>>>,
  propertyId: string,
  rolePermissions: readonly string[]
) {
  const actorPermissions = auth.bundle.assignments
    .filter((assignment) => assignment.property_id === propertyId)
    .flatMap((assignment) => assignment.role?.permissions ?? []);
  if (rolePermissions.includes("*")) return actorPermissions.includes("*");
  return rolePermissions.every((permission) => permissionGranted(actorPermissions, permission));
}

function validLimits(body: UserRequestBody) {
  const discount = body.max_discount_percent === undefined ? 0 : Number(body.max_discount_percent);
  const voidAmount = body.max_void_amount === undefined ? 0 : Number(body.max_void_amount);
  if (!Number.isFinite(discount) || discount < 0 || discount > 100 ||
      !Number.isFinite(voidAmount) || voidAmount < 0) return null;
  if (body.can_override_approval !== undefined && typeof body.can_override_approval !== "boolean") return null;
  return {
    discount,
    voidAmount,
    canOverride: body.can_override_approval === true,
  };
}

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "23505";
}

async function readBody(request: Request): Promise<UserRequestBody | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null ? body as UserRequestBody : null;
  } catch {
    return null;
  }
}

async function requireAdmin(permission = "users:manage") {
  const auth = await getAuthContext();
  if (!auth) return { response: NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 }) } as const;
  const propertyIds = permissionPropertyIds(auth, permission);
  if (propertyIds.length === 0) {
    return { response: NextResponse.json({ success: false, message: "You do not have permission to manage staff accounts." }, { status: 403 }) } as const;
  }
  return { auth, propertyIds } as const;
}

export async function GET() {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const access = await requireAdmin();
  if ("response" in access) return access.response;
  const { auth, propertyIds } = access;

  let result: UserDirectoryRows;
  try {
    result = await withUserContext(auth.userId, async (run) => {
    const [staff, properties, roles] = await Promise.all([
      run<StaffRow>(
        `SELECT u.id, u.full_name, u.email, u.phone_number, u.is_active,
                (u.pin_hash IS NOT NULL) AS pin_enabled,
                NOT EXISTS (
                  SELECT 1 FROM user_assignments other_ua
                  WHERE other_ua.user_id = u.id
                    AND NOT (other_ua.property_id = ANY($2::uuid[]))
                ) AS account_management_allowed,
                ua.id AS assignment_id, ua.property_id, p.code AS property_code,
                r.id AS role_id, r.name AS role_name, ua.is_active AS assignment_active,
                ua.outlet_id, ua.station_id, ua.max_discount_percent, ua.max_void_amount,
                ua.can_override_approval
         FROM users u
         JOIN user_assignments ua ON ua.user_id = u.id
         JOIN properties p ON p.id = ua.property_id
         JOIN roles r ON r.id = ua.role_id
         WHERE u.company_id = $1 AND p.company_id = $1
           AND p.id = ANY($2::uuid[])
         ORDER BY u.full_name, p.code, r.name`,
        [auth.bundle.company.id, propertyIds]
      ),
      run<{ id: string; name: string; code: string }>(
        `SELECT id, name, code FROM properties
         WHERE company_id = $1 AND id = ANY($2::uuid[]) AND is_active = TRUE
         ORDER BY name`,
        [auth.bundle.company.id, propertyIds]
      ),
      run<{ id: string; name: string; permissions: string[] }>(
        `SELECT id, name, permissions FROM roles
         WHERE company_id = $1 OR company_id IS NULL
         ORDER BY name`,
        [auth.bundle.company.id]
      ),
    ]);
      return { staff: staff.rows, properties: properties.rows, roles: roles.rows };
    });
  } catch (error) {
    console.error("Failed to load staff accounts.", error);
    return NextResponse.json({ success: false, message: "Staff accounts could not be loaded." }, { status: 500 });
  }

  const byUser = new Map<string, {
    id: string;
    full_name: string;
    email: string | null;
    phone_number: string | null;
    is_active: boolean;
    pin_enabled: boolean;
    account_management_allowed: boolean;
    assignments: {
      id: string;
      property_id: string;
      property_code: string;
      role_id: string;
      role_name: string;
      is_active: boolean;
      outlet_id: string | null;
      station_id: string | null;
      max_discount_percent: number;
      max_void_amount: number;
      can_override_approval: boolean;
    }[];
  }>();

  for (const row of result.staff) {
    let member = byUser.get(row.id);
    if (!member) {
      member = {
        id: row.id,
        full_name: row.full_name,
        email: row.email,
        phone_number: row.phone_number,
        is_active: row.is_active,
        pin_enabled: row.pin_enabled,
        account_management_allowed: row.account_management_allowed,
        assignments: [],
      };
      byUser.set(row.id, member);
    }
    member.assignments.push({
      id: row.assignment_id,
      property_id: row.property_id,
      property_code: row.property_code,
      role_id: row.role_id,
      role_name: row.role_name,
      is_active: row.assignment_active,
      outlet_id: row.outlet_id,
      station_id: row.station_id,
      max_discount_percent: Number(row.max_discount_percent),
      max_void_amount: Number(row.max_void_amount),
      can_override_approval: row.can_override_approval,
    });
  }

  return NextResponse.json({
    success: true,
    users: Array.from(byUser.values()),
    properties: result.properties,
    roles: result.roles.map(({ id, name }) => ({ id, name })),
  });
}

export async function POST(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const access = await requireAdmin();
  if ("response" in access) return access.response;
  const { auth, propertyIds } = access;
  const body = await readBody(request);
  if (!body) return NextResponse.json({ success: false, message: "Request body must be a valid JSON object." }, { status: 400 });

  const fullName = typeof body.full_name === "string" ? body.full_name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const phone = typeof body.phone_number === "string" ? body.phone_number.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const pin = typeof body.pin === "string" ? body.pin : body.pin === undefined ? "" : null;
  const propertyId = typeof body.property_id === "string" ? body.property_id : "";
  const roleId = typeof body.role_id === "string" ? body.role_id : "";
  const limits = validLimits(body);

  if (!fullName || fullName.length > 255 || (!email && !phone) || email.length > 255 || phone.length > 50 ||
      password.length < 12 || password.length > 128 || !propertyId || !roleId || !limits) {
    return NextResponse.json({
      success: false,
      message: "Provide a name, email or phone, a password of at least 12 characters, a managed property, a role, and valid approval limits.",
    }, { status: 400 });
  }
  if (pin === null || (pin !== "" && !/^\d{4}$/.test(pin))) {
    return NextResponse.json({ success: false, message: "A quick-login PIN must contain exactly four digits." }, { status: 400 });
  }
  if (!propertyIds.includes(propertyId)) {
    return NextResponse.json({ success: false, message: "You cannot assign users to that property." }, { status: 403 });
  }
  const outletId = typeof body.outlet_id === "string" && body.outlet_id ? body.outlet_id : null;
  const stationId = typeof body.station_id === "string" && body.station_id ? body.station_id : null;
  if (stationId && !outletId) {
    return NextResponse.json({ success: false, message: "A station must belong to a selected outlet." }, { status: 400 });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const pinHash = pin ? await bcrypt.hash(pin, 12) : null;
  try {
    const userId = await withUserContext(auth.userId, async (run) => {
      const property = await run<{ id: string }>(
        `SELECT id FROM properties WHERE id = $1 AND company_id = $2 AND is_active = TRUE`,
        [propertyId, auth.bundle.company.id]
      );
      const role = await run<{ id: string; permissions: string[] }>(
        `SELECT id, permissions FROM roles WHERE id = $1 AND (company_id = $2 OR company_id IS NULL)`,
        [roleId, auth.bundle.company.id]
      );
      if (!property.rows[0] || !role.rows[0]) return null;
      if (!canGrantRole(auth, propertyId, role.rows[0].permissions)) return "forbidden" as const;
      if (outletId) {
        const outlet = await run<{ id: string }>(
          `SELECT id FROM outlets WHERE id = $1 AND property_id = $2 AND is_active = TRUE`,
          [outletId, propertyId]
        );
        if (!outlet.rows[0]) return null;
      }
      if (stationId) {
        const station = await run<{ id: string }>(
          `SELECT id FROM stations WHERE id = $1 AND outlet_id = $2 AND is_active = TRUE`,
          [stationId, outletId]
        );
        if (!station.rows[0]) return null;
      }
      const inserted = await run<{ id: string }>(
        `INSERT INTO users (company_id, full_name, email, phone_number, password_hash, pin_hash)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [auth.bundle.company.id, fullName, email || null, phone || null, passwordHash, pinHash]
      );
      const id = inserted.rows[0].id;
      await run(
        `INSERT INTO user_assignments
           (user_id, property_id, outlet_id, station_id, role_id, max_discount_percent, max_void_amount, can_override_approval)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, propertyId, outletId, stationId, roleId, limits.discount, limits.voidAmount, limits.canOverride]
      );
      await run(
        `INSERT INTO audit_log (company_id, property_id, actor_user_id, action_type, resource_type, resource_id, payload_after)
         VALUES ($1, $2, $3, 'USER.CREATE', 'users', $4, $5::jsonb)`,
        [auth.bundle.company.id, propertyId, auth.userId, id, JSON.stringify({ full_name: fullName, email: email || null, role_id: roleId, quick_login_enabled: pinHash !== null })]
      );
      return id;
    });
    if (userId === "forbidden") {
      return NextResponse.json({ success: false, message: "You cannot assign a role with permissions you do not hold in that property." }, { status: 403 });
    }
    if (!userId) return NextResponse.json({ success: false, message: "The selected property, role, outlet, or station is no longer available for this company." }, { status: 400 });
    return NextResponse.json({ success: true, user_id: userId }, { status: 201 });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return NextResponse.json({ success: false, message: "That email address or phone number is already in use." }, { status: 409 });
    }
    console.error("Failed to create staff user.", error);
    return NextResponse.json({ success: false, message: "The staff account could not be created." }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const access = await requireAdmin();
  if ("response" in access) return access.response;
  const { auth, propertyIds } = access;
  const body = await readBody(request);
  if (!body) return NextResponse.json({ success: false, message: "Request body must be a valid JSON object." }, { status: 400 });

  const userId = typeof body.user_id === "string" ? body.user_id : "";
  const action = body.action;
  if (!userId || (action !== "suspend" && action !== "activate" && action !== "update_assignment")) {
    return NextResponse.json({ success: false, message: "A user_id and valid action are required." }, { status: 400 });
  }
  if (userId === auth.userId) {
    return NextResponse.json({ success: false, message: "You cannot change your own account or privileges here." }, { status: 403 });
  }

  if (action === "update_assignment") {
    const assignmentId = typeof body.assignment_id === "string" ? body.assignment_id : "";
    const roleId = typeof body.role_id === "string" ? body.role_id : "";
    const limits = validLimits(body);
    const pin = typeof body.pin === "string" ? body.pin : body.pin === undefined ? "" : null;
    const clearPin = body.clear_pin === true;
    if (!assignmentId || !roleId || !limits) {
      return NextResponse.json({ success: false, message: "An assignment, role, and valid approval limits are required." }, { status: 400 });
    }
    if (pin === null || (pin !== "" && !/^\d{4}$/.test(pin)) ||
        (body.clear_pin !== undefined && typeof body.clear_pin !== "boolean") ||
        (clearPin && pin !== "")) {
      return NextResponse.json({ success: false, message: "Enter exactly four digits for a new PIN, or clear the existing PIN." }, { status: 400 });
    }
    const pinHash = pin ? await bcrypt.hash(pin, 12) : null;
    const outletId = typeof body.outlet_id === "string" && body.outlet_id ? body.outlet_id : null;
    const stationId = typeof body.station_id === "string" && body.station_id ? body.station_id : null;
    if (stationId && !outletId) {
      return NextResponse.json({ success: false, message: "A station must belong to a selected outlet." }, { status: 400 });
    }

    let outcome: "not_found" | "invalid" | "forbidden" | "updated";
    try {
      outcome = await withUserContext(auth.userId, async (run) => {
      const existing = await run<{
        id: string; property_id: string; outlet_id: string | null; station_id: string | null;
        role_id: string; max_discount_percent: string; max_void_amount: string; can_override_approval: boolean;
      }>(
        `SELECT ua.id, ua.property_id, ua.outlet_id, ua.station_id, ua.role_id,
                ua.max_discount_percent, ua.max_void_amount, ua.can_override_approval
         FROM user_assignments ua
         JOIN users u ON u.id = ua.user_id
         WHERE ua.id = $1 AND ua.user_id = $2 AND u.company_id = $3
           AND ua.property_id = ANY($4::uuid[])
         FOR UPDATE OF ua`,
        [assignmentId, userId, auth.bundle.company.id, propertyIds]
      );
      if (!existing.rows[0]) return "not_found" as const;
      const role = await run<{ id: string; permissions: string[] }>(
        `SELECT id, permissions FROM roles WHERE id = $1 AND (company_id = $2 OR company_id IS NULL)`,
        [roleId, auth.bundle.company.id]
      );
      if (!role.rows[0]) return "invalid" as const;
      if (!canGrantRole(auth, existing.rows[0].property_id, role.rows[0].permissions)) return "forbidden" as const;
      if (outletId) {
        const outlet = await run<{ id: string }>(
          `SELECT id FROM outlets WHERE id = $1 AND property_id = $2 AND is_active = TRUE`,
          [outletId, existing.rows[0].property_id]
        );
        if (!outlet.rows[0]) return "invalid" as const;
      }
      if (stationId) {
        const station = await run<{ id: string }>(
          `SELECT id FROM stations WHERE id = $1 AND outlet_id = $2 AND is_active = TRUE`,
          [stationId, outletId]
        );
        if (!station.rows[0]) return "invalid" as const;
      }
      await run(
        `UPDATE user_assignments
         SET role_id = $1, outlet_id = $2, station_id = $3, max_discount_percent = $4,
             max_void_amount = $5, can_override_approval = $6, updated_at = NOW()
         WHERE id = $7`,
        [roleId, outletId, stationId, limits.discount, limits.voidAmount, limits.canOverride, assignmentId]
      );
      if (clearPin || pinHash) {
        await run(`UPDATE users SET pin_hash = $1, updated_at = NOW() WHERE id = $2`, [clearPin ? null : pinHash, userId]);
        await run(
          `INSERT INTO audit_log (company_id, property_id, actor_user_id, action_type, resource_type, resource_id, payload_after)
           VALUES ($1, $2, $3, $4, 'users', $5, $6::jsonb)`,
          [
            auth.bundle.company.id, existing.rows[0].property_id, auth.userId,
            clearPin ? "USER.PIN_CLEAR" : "USER.PIN_SET", userId,
            JSON.stringify({ quick_login_enabled: !clearPin }),
          ]
        );
      }
      await run(`UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
      await run(`DELETE FROM cashier_outlet_sessions WHERE user_id = $1`, [userId]);
      await run(
        `INSERT INTO audit_log (company_id, property_id, actor_user_id, action_type, resource_type, resource_id, payload_before, payload_after)
         VALUES ($1, $2, $3, 'USER.PRIVILEGES_UPDATE', 'user_assignments', $4, $5::jsonb, $6::jsonb)`,
        [
          auth.bundle.company.id, existing.rows[0].property_id, auth.userId, assignmentId,
          JSON.stringify(existing.rows[0]),
          JSON.stringify({ role_id: roleId, outlet_id: outletId, station_id: stationId, max_discount_percent: limits.discount, max_void_amount: limits.voidAmount, can_override_approval: limits.canOverride }),
        ]
      );
        return "updated" as const;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return NextResponse.json({ success: false, message: "That assignment conflicts with an existing role assignment." }, { status: 409 });
      }
      console.error("Failed to update staff privileges.", error);
      return NextResponse.json({ success: false, message: "Staff privileges could not be updated." }, { status: 500 });
    }
    if (outcome === "not_found") return NextResponse.json({ success: false, message: "That user assignment was not found in a property you manage." }, { status: 404 });
    if (outcome === "invalid") return NextResponse.json({ success: false, message: "The selected role, outlet, or station is invalid for this assignment." }, { status: 400 });
    if (outcome === "forbidden") {
      return NextResponse.json({ success: false, message: "You cannot assign a role with permissions you do not hold in that property." }, { status: 403 });
    }
    return NextResponse.json({ success: true });
  }

  let outcome: "not_found" | "unchanged" | "updated";
  try {
    outcome = await withUserContext(auth.userId, async (run) => {
    const result = await run<{ id: string; is_active: boolean }>(
      `SELECT u.id, u.is_active FROM users u
       WHERE u.id = $1 AND u.company_id = $2
         AND EXISTS (
           SELECT 1 FROM user_assignments ua
           WHERE ua.user_id = u.id AND ua.property_id = ANY($3::uuid[])
         )
         AND NOT EXISTS (
           SELECT 1 FROM user_assignments other_ua
           WHERE other_ua.user_id = u.id
             AND NOT (other_ua.property_id = ANY($3::uuid[]))
         )
       FOR UPDATE`,
      [userId, auth.bundle.company.id, propertyIds]
    );
    const user = result.rows[0];
    if (!user) return "not_found" as const;
    if (user.is_active === (action === "activate")) return "unchanged" as const;
    await run(`UPDATE users SET is_active = $1, updated_at = NOW() WHERE id = $2`, [action === "activate", userId]);
    if (action === "suspend") {
      await run(`UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
      await run(`DELETE FROM cashier_outlet_sessions WHERE user_id = $1`, [userId]);
    }
    await run(
      `INSERT INTO audit_log (company_id, actor_user_id, action_type, resource_type, resource_id, payload_before, payload_after)
       VALUES ($1, $2, $3, 'users', $4, $5::jsonb, $6::jsonb)`,
      [
        auth.bundle.company.id, auth.userId, action === "suspend" ? "USER.SUSPEND" : "USER.ACTIVATE",
        userId, JSON.stringify({ is_active: user.is_active }), JSON.stringify({ is_active: action === "activate" }),
      ]
    );
      return "updated" as const;
    });
  } catch (error) {
    console.error("Failed to change staff account status.", error);
    return NextResponse.json({ success: false, message: "The staff account status could not be changed." }, { status: 500 });
  }
  if (outcome === "not_found") return NextResponse.json({ success: false, message: "That user is not fully within your account-management scope." }, { status: 404 });
  if (outcome === "unchanged") return NextResponse.json({ success: false, message: "The account already has that status." }, { status: 409 });
  return NextResponse.json({ success: true });
}
