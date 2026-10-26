import "server-only";
import { getPool, query, withUserContext } from "@/lib/db/postgres";
import { createSessionToken, hashSessionId, SESSION_TTL_MS } from "@/lib/auth/session";
import { permissionGranted } from "@/lib/auth/permissions";
import type { Company, Outlet, Property, Role, Station, User, UserAssignment } from "@/lib/types/database";

export interface AuthenticatedUserRow {
  id: string;
  company_id: string;
  full_name: string;
  email: string | null;
  phone_number: string | null;
  password_hash: string;
  pin_hash: string | null;
  is_active: boolean;
}

/** Looks up a user by email or phone number for login. Does not check RLS — `users` has no policy defined, so this relies on the app connecting with the table-owning role (see DATABASE_SETUP.md). */
export async function findUserByIdentifier(identifier: string): Promise<AuthenticatedUserRow | null> {
  const cleaned = identifier.trim().toLowerCase();
  const result = await query<AuthenticatedUserRow>(
    `SELECT id, company_id, full_name, email, phone_number, password_hash, pin_hash, is_active
     FROM users
     WHERE (email IS NOT NULL AND lower(email) = $1)
        OR (phone_number IS NOT NULL AND regexp_replace(phone_number, '\\s+', '', 'g') = regexp_replace($2, '\\s+', '', 'g'))
     LIMIT 1`,
    [cleaned, identifier.trim()]
  );
  return result.rows[0] ?? null;
}

export class CashierOutletSessionConflictError extends Error {
  constructor(readonly outletId: string) {
    super("A cashier session is already active for an assigned outlet.");
    this.name = "CashierOutletSessionConflictError";
  }
}

export async function createSession(
  userId: string,
  companyId: string,
  ipAddress: string | null,
  userAgent: string | null,
  cashierOutletIds: string[]
) {
  const { sessionId, cookieValue } = createSessionToken();
  const tokenHash = hashSessionId(sessionId);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const db = getPool();
  if (!db) throw new Error("DATABASE_URL is not configured.");
  const reservedOutletIds = Array.from(new Set(cashierOutletIds));
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM cashier_outlet_sessions cos
       WHERE NOT EXISTS (
         SELECT 1 FROM sessions s
         WHERE s.id = cos.session_id AND s.revoked_at IS NULL AND s.expires_at > NOW()
       )`
    );
    const sessionResult = await client.query<{ id: string }>(
      `INSERT INTO sessions (user_id, token_hash, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [userId, tokenHash, ipAddress, userAgent, expiresAt.toISOString()]
    );
    const databaseSessionId = sessionResult.rows[0].id;

    if (reservedOutletIds.length > 0) {
      const reservationResult = await client.query<{ outlet_id: string }>(
        `INSERT INTO cashier_outlet_sessions (outlet_id, session_id, user_id)
         SELECT requested.outlet_id, $2, $3
         FROM unnest($1::uuid[]) AS requested(outlet_id)
         ON CONFLICT (outlet_id) DO NOTHING
         RETURNING outlet_id`,
        [reservedOutletIds, databaseSessionId, userId]
      );
      const reservedOutlets = new Set(reservationResult.rows.map((row) => row.outlet_id));
      const conflictingOutletId = reservedOutletIds.find((outletId) => !reservedOutlets.has(outletId));
      if (conflictingOutletId) throw new CashierOutletSessionConflictError(conflictingOutletId);
    }

    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
    await client.query(
      `INSERT INTO audit_log (company_id, actor_user_id, action_type, resource_type, resource_id, ip_address, user_agent)
       VALUES ($1, $2, 'AUTH.LOGIN', 'sessions', $3, $4, $5)`,
      [companyId, userId, databaseSessionId, ipAddress, userAgent]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return { cookieValue, expiresAt };
}

export async function revokeSession(sessionId: string) {
  const tokenHash = hashSessionId(sessionId);
  await query(
    `WITH revoked AS (
       UPDATE sessions SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL
       RETURNING id
     )
     DELETE FROM cashier_outlet_sessions cos
     USING revoked
     WHERE cos.session_id = revoked.id`,
    [tokenHash]
  );
}

/** Resolves a verified-but-not-yet-DB-checked session id to its active user id, or null if expired/revoked/unknown. */
export async function resolveSessionUserId(sessionId: string): Promise<string | null> {
  const tokenHash = hashSessionId(sessionId);
  const result = await query<{ user_id: string }>(
    `SELECT user_id FROM sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
    [tokenHash]
  );
  return result.rows[0]?.user_id ?? null;
}

export interface UserBundle {
  user: User;
  company: Company;
  assignments: UserAssignment[];
  properties: Property[];
  outlets: Outlet[];
  stations: Station[];
  roles: Role[];
}

export function cashierOutletIdsForUser(bundle: UserBundle): string[] {
  const outletIds = new Set<string>();

  for (const assignment of bundle.assignments) {
    if (!assignment.role) continue;
    const permissions = assignment.role.permissions;
    const isCashierRole = assignment.role.role_key.toLowerCase() === "cashier";
    const canOperateCashierShift = !permissions.includes("*") &&
      permissions.includes("shift:open") &&
      permissionGranted(permissions, "pos:write");
    if (!isCashierRole && !canOperateCashierShift) continue;
    if (assignment.outlet_id) {
      outletIds.add(assignment.outlet_id);
    } else if (assignment.station_id) {
      const station = bundle.stations.find((candidate) => candidate.id === assignment.station_id);
      if (station) outletIds.add(station.outlet_id);
    } else {
      for (const outlet of bundle.outlets) {
        if (outlet.property_id === assignment.property_id) outletIds.add(outlet.id);
      }
    }
  }

  return Array.from(outletIds);
}

export async function hasCashierOutletReservations(sessionId: string, userId: string, outletIds: string[]) {
  if (outletIds.length === 0) return true;
  const tokenHash = hashSessionId(sessionId);
  const result = await query<{ has_all: boolean }>(
    `SELECT NOT EXISTS (
       SELECT 1 FROM unnest($3::uuid[]) AS required(outlet_id)
       WHERE NOT EXISTS (
         SELECT 1 FROM cashier_outlet_sessions cos
         JOIN sessions s ON s.id = cos.session_id
         WHERE cos.outlet_id = required.outlet_id
           AND s.token_hash = $1 AND cos.user_id = $2
       )
     ) AS has_all`,
    [tokenHash, userId, outletIds]
  );
  return result.rows[0]?.has_all === true;
}

/**
 * Loads everything the client store needs right after login/session-restore:
 * the user, their company, and every active assignment (with the related role,
 * property, outlet and station already joined in). Scoped by `user_id = $1`
 * directly rather than relying on RLS, since `users`/`user_assignments` have no
 * policy defined (table-owner bypass — see db/migrations/001).
 */
export async function getUserBundle(userId: string): Promise<UserBundle | null> {
  const userResult = await query<User & { company_id: string }>(
    `SELECT id, company_id, full_name, email, phone_number, is_active, created_at, updated_at
     FROM users WHERE id = $1 AND is_active = TRUE`,
    [userId]
  );
  const user = userResult.rows[0];
  if (!user) return null;

  const companyResult = await query<Company>(
    `SELECT id, name, tax_pin, country_code, currency, created_at, updated_at FROM companies WHERE id = $1`,
    [user.company_id]
  );
  const company = companyResult.rows[0];
  if (!company) return null;

  const assignmentRows = await query<
    UserAssignment & {
      role_name: string; role_key: string; role_permissions: string[]; role_description: string | null; role_is_system: boolean; role_created_at: string;
      property_name: string; property_code: string; property_type: Property["property_type"]; property_address: string | null; property_phone: string | null; property_email: string | null; property_is_active: boolean; property_created_at: string; property_updated_at: string; property_company_id: string;
      outlet_name: string | null; outlet_code: string | null; outlet_type: Outlet["outlet_type"] | null; outlet_is_active: boolean | null; outlet_created_at: string | null; outlet_updated_at: string | null;
      station_name: string | null; station_type: Station["station_type"] | null; station_hardware_id: string | null; station_is_active: boolean | null; station_created_at: string | null; station_updated_at: string | null;
    }
  >(
    `SELECT
       ua.id, ua.user_id, ua.property_id, ua.outlet_id, ua.station_id, ua.role_id,
       ua.max_discount_percent, ua.max_void_amount, ua.can_override_approval,
       ua.effective_from, ua.effective_to, ua.is_active,
       r.name AS role_name, r.role_key, r.permissions AS role_permissions, r.description AS role_description, r.is_system_role AS role_is_system, r.created_at AS role_created_at,
       p.name AS property_name, p.code AS property_code, p.property_type, p.physical_address AS property_address, p.phone_number AS property_phone, p.email AS property_email, p.is_active AS property_is_active, p.created_at AS property_created_at, p.updated_at AS property_updated_at, p.company_id AS property_company_id,
       o.name AS outlet_name, o.code AS outlet_code, o.outlet_type, o.is_active AS outlet_is_active, o.created_at AS outlet_created_at, o.updated_at AS outlet_updated_at,
       s.name AS station_name, s.station_type, s.hardware_identifier AS station_hardware_id, s.is_active AS station_is_active, s.created_at AS station_created_at, s.updated_at AS station_updated_at
     FROM user_assignments ua
     JOIN roles r ON r.id = ua.role_id
     JOIN properties p ON p.id = ua.property_id
     LEFT JOIN outlets o ON o.id = ua.outlet_id
     LEFT JOIN stations s ON s.id = ua.station_id
     WHERE ua.user_id = $1 AND ua.is_active = TRUE AND p.is_active = TRUE
     ORDER BY p.name`,
    [userId]
  );

  const propertiesById = new Map<string, Property>();
  const outletsById = new Map<string, Outlet>();
  const stationsById = new Map<string, Station>();
  const rolesById = new Map<string, Role>();
  const assignments: UserAssignment[] = assignmentRows.rows.map((row) => {
    propertiesById.set(row.property_id, {
      id: row.property_id,
      company_id: row.property_company_id,
      name: row.property_name,
      code: row.property_code,
      property_type: row.property_type,
      physical_address: row.property_address ?? undefined,
      phone_number: row.property_phone ?? undefined,
      email: row.property_email ?? undefined,
      is_active: row.property_is_active,
      created_at: row.property_created_at,
      updated_at: row.property_updated_at,
    });
    if (row.outlet_id && row.outlet_name && row.outlet_code && row.outlet_type) {
      outletsById.set(row.outlet_id, {
        id: row.outlet_id,
        property_id: row.property_id,
        name: row.outlet_name,
        code: row.outlet_code,
        outlet_type: row.outlet_type,
        is_active: row.outlet_is_active ?? true,
        created_at: row.outlet_created_at ?? row.property_created_at,
        updated_at: row.outlet_updated_at ?? row.property_updated_at,
      });
    }
    if (row.station_id && row.station_name && row.station_type) {
      stationsById.set(row.station_id, {
        id: row.station_id,
        outlet_id: row.outlet_id ?? "",
        name: row.station_name,
        station_type: row.station_type,
        hardware_identifier: row.station_hardware_id ?? undefined,
        is_active: row.station_is_active ?? true,
        created_at: row.station_created_at ?? row.property_created_at,
        updated_at: row.station_updated_at ?? row.property_updated_at,
      });
    }
    rolesById.set(row.role_id, {
      id: row.role_id,
      name: row.role_name,
      role_key: row.role_key,
      description: row.role_description ?? undefined,
      permissions: row.role_permissions,
      is_system_role: row.role_is_system,
      created_at: row.role_created_at,
    });

    return {
      id: row.id,
      user_id: row.user_id,
      property_id: row.property_id,
      outlet_id: row.outlet_id ?? undefined,
      station_id: row.station_id ?? undefined,
      role_id: row.role_id,
      role: rolesById.get(row.role_id),
      property: propertiesById.get(row.property_id),
      outlet: row.outlet_id ? outletsById.get(row.outlet_id) : undefined,
      station: row.station_id ? stationsById.get(row.station_id) : undefined,
      max_discount_percent: Number(row.max_discount_percent),
      max_void_amount: Number(row.max_void_amount),
      can_override_approval: row.can_override_approval,
      effective_from: row.effective_from,
      effective_to: row.effective_to ?? undefined,
      is_active: row.is_active,
    };
  });

  // Assignment rows only carry the specific outlet/station a user is pinned to
  // (e.g. a cashier tied to one till). A property-wide assignment (e.g. a
  // general manager) has outlet_id/station_id = NULL, so also load every
  // outlet/station under the properties they're assigned to, or they'd have
  // no way to pick an outlet/till at all.
  const propertyIds = Array.from(propertiesById.keys());
  if (propertyIds.length > 0) {
    const outletRows = await query<Outlet>(
      `SELECT id, property_id, name, code, outlet_type, is_active, created_at, updated_at
       FROM outlets WHERE property_id = ANY($1::uuid[]) AND is_active = TRUE`,
      [propertyIds]
    );
    for (const outlet of outletRows.rows) outletsById.set(outlet.id, outlet);

    const outletIds = Array.from(outletsById.keys());
    if (outletIds.length > 0) {
      const stationRows = await query<Station>(
        `SELECT id, outlet_id, name, station_type, hardware_identifier, is_active, created_at, updated_at
         FROM stations WHERE outlet_id = ANY($1::uuid[]) AND is_active = TRUE`,
        [outletIds]
      );
      for (const station of stationRows.rows) stationsById.set(station.id, station);
    }
  }

  return {
    user: {
      id: user.id,
      company_id: user.company_id,
      full_name: user.full_name,
      email: user.email ?? undefined,
      phone_number: user.phone_number ?? undefined,
      is_active: user.is_active,
      created_at: user.created_at,
      updated_at: user.updated_at,
    },
    company,
    assignments,
    properties: Array.from(propertiesById.values()),
    outlets: Array.from(outletsById.values()),
    stations: Array.from(stationsById.values()),
    roles: Array.from(rolesById.values()),
  };
}

/** Records an append-only audit entry. Uses withUserContext so it's also tenant-scoped like everything else the authenticated request touches. */
export async function recordAuditEvent(input: {
  userId: string;
  companyId: string;
  propertyId?: string;
  outletId?: string;
  actionType: string;
  resourceType: string;
  resourceId?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  await withUserContext(input.userId, async (run) => {
    await run(
      `INSERT INTO audit_log (company_id, property_id, outlet_id, actor_user_id, action_type, resource_type, resource_id, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [input.companyId, input.propertyId ?? null, input.outletId ?? null, input.userId, input.actionType, input.resourceType, input.resourceId ?? null, input.ipAddress ?? null, input.userAgent ?? null]
    );
  });
}
