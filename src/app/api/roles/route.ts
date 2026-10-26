import { NextResponse } from "next/server";
import type { QueryResultRow } from "pg";
import { PERMISSION_KEYS } from "@/lib/auth/permissions";
import { getAuthContext, hasPermission } from "@/lib/auth/require-session";
import { databaseReady, withUserContext } from "@/lib/db/postgres";

export const runtime = "nodejs";

interface RoleRow extends QueryResultRow {
  id: string;
  name: string;
  role_key: string;
  description: string | null;
  permissions: string[];
  is_system_role: boolean;
  editable?: boolean;
}

interface RoleBody {
  role_id?: unknown;
  name?: unknown;
  description?: unknown;
  permissions?: unknown;
}

const allowedPermissions = new Set<string>(PERMISSION_KEYS);

function roleManagementPropertyIds(auth: NonNullable<Awaited<ReturnType<typeof getAuthContext>>>) {
  return Array.from(new Set(auth.bundle.assignments
    .filter((assignment) => hasPermission(auth.bundle, assignment.property_id, "roles:manage"))
    .map((assignment) => assignment.property_id)));
}

function canManageRoles(auth: NonNullable<Awaited<ReturnType<typeof getAuthContext>>>) {
  return roleManagementPropertyIds(auth).length > 0;
}

function readRoleInput(body: RoleBody) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const permissions = body.permissions;
  const roleKey = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50);
  if (!name || name.length > 100 || description.length > 500 || !roleKey ||
      !Array.isArray(permissions) || permissions.length === 0 ||
      !permissions.every((permission): permission is string =>
        typeof permission === "string" && allowedPermissions.has(permission)
      )) {
    return null;
  }
  return { name, description: description || null, roleKey, permissions: Array.from(new Set(permissions)) };
}

async function readBody(request: Request): Promise<RoleBody | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null ? body as RoleBody : null;
  } catch {
    return null;
  }
}

export async function GET() {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });
  if (!canManageRoles(auth)) return NextResponse.json({ success: false, message: "You do not have permission to manage roles." }, { status: 403 });
  const propertyIds = roleManagementPropertyIds(auth);

  try {
    const roles = await withUserContext(auth.userId, async (run) => {
      const result = await run<RoleRow>(
        `SELECT r.id, r.name, r.role_key, r.description, r.permissions, r.is_system_role,
                (NOT r.is_system_role AND r.company_id = $1 AND NOT EXISTS (
                  SELECT 1 FROM user_assignments ua
                  WHERE ua.role_id = r.id AND NOT (ua.property_id = ANY($2::uuid[]))
                ) AND NOT EXISTS (
                  SELECT 1 FROM user_assignments ua
                  WHERE ua.role_id = r.id AND ua.user_id = $3
                )) AS editable
         FROM roles r
         WHERE r.company_id = $1 OR r.company_id IS NULL
         ORDER BY r.is_system_role DESC, r.name`,
        [auth.bundle.company.id, propertyIds, auth.userId]
      );
      return result.rows;
    });
    return NextResponse.json({ success: true, roles });
  } catch (error) {
    console.error("Failed to load roles.", error);
    return NextResponse.json({ success: false, message: "Roles could not be loaded." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });
  if (!canManageRoles(auth)) return NextResponse.json({ success: false, message: "You do not have permission to manage roles." }, { status: 403 });

  const body = await readBody(request);
  const input = body && readRoleInput(body);
  if (!input) return NextResponse.json({ success: false, message: "Enter a role name and at least one valid permission." }, { status: 400 });

  try {
    const result = await withUserContext(auth.userId, async (run) => {
      await run(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [auth.bundle.company.id, input.roleKey]);
      const duplicate = await run<{ id: string }>(
        `SELECT id FROM roles WHERE (company_id = $1 OR company_id IS NULL) AND role_key = $2 LIMIT 1`,
        [auth.bundle.company.id, input.roleKey]
      );
      if (duplicate.rows[0]) return { outcome: "duplicate" as const };

      const inserted = await run<RoleRow>(
        `INSERT INTO roles (company_id, name, role_key, description, permissions, is_system_role)
         VALUES ($1, $2, $3, $4, $5::jsonb, FALSE)
         RETURNING id, name, role_key, description, permissions, is_system_role`,
        [auth.bundle.company.id, input.name, input.roleKey, input.description, JSON.stringify(input.permissions)]
      );
      const role = inserted.rows[0];
      await run(
        `INSERT INTO audit_log (company_id, actor_user_id, action_type, resource_type, resource_id, payload_after)
         VALUES ($1, $2, 'ROLE.CREATE', 'roles', $3, $4::jsonb)`,
        [auth.bundle.company.id, auth.userId, role.id, JSON.stringify({ name: role.name, role_key: role.role_key, permissions: role.permissions })]
      );
      return { outcome: "created" as const, role };
    });

    if (result.outcome === "duplicate") {
      return NextResponse.json({ success: false, message: "A role with that name already exists." }, { status: 409 });
    }
    return NextResponse.json({ success: true, role: result.role }, { status: 201 });
  } catch (error) {
    console.error("Failed to create role.", error);
    return NextResponse.json({ success: false, message: "The role could not be created." }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });
  if (!canManageRoles(auth)) return NextResponse.json({ success: false, message: "You do not have permission to manage roles." }, { status: 403 });

  const body = await readBody(request);
  const roleId = typeof body?.role_id === "string" ? body.role_id : "";
  const input = body && readRoleInput(body);
  if (!roleId || !input) {
    return NextResponse.json({ success: false, message: "A custom role, name, and at least one valid permission are required." }, { status: 400 });
  }
  const propertyIds = roleManagementPropertyIds(auth);

  try {
    const result = await withUserContext(auth.userId, async (run) => {
      await run(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [auth.bundle.company.id, input.roleKey]);
      const existing = await run<RoleRow>(
        `SELECT id, name, role_key, description, permissions, is_system_role
         FROM roles r WHERE r.id = $1 AND r.company_id = $2 AND r.is_system_role = FALSE
           AND NOT EXISTS (
             SELECT 1 FROM user_assignments ua
             WHERE ua.role_id = r.id AND NOT (ua.property_id = ANY($3::uuid[]))
           )
         FOR UPDATE`,
        [roleId, auth.bundle.company.id, propertyIds]
      );
      const role = existing.rows[0];
      if (!role) {
        const exists = await run<{ id: string }>(
          `SELECT id FROM roles WHERE id = $1 AND company_id = $2 AND is_system_role = FALSE`,
          [roleId, auth.bundle.company.id]
        );
        return { outcome: exists.rows[0] ? "out_of_scope" as const : "not_found" as const };
      }

      const selfAssignment = await run<{ id: string }>(
        `SELECT id FROM user_assignments WHERE user_id = $1 AND role_id = $2 LIMIT 1`,
        [auth.userId, roleId]
      );
      if (selfAssignment.rows[0]) return { outcome: "self_assignment" as const };

      const duplicate = await run<{ id: string }>(
        `SELECT id FROM roles
         WHERE (company_id = $1 OR company_id IS NULL) AND role_key = $2 AND id <> $3 LIMIT 1`,
        [auth.bundle.company.id, input.roleKey, roleId]
      );
      if (duplicate.rows[0]) return { outcome: "duplicate" as const };

      const updated = await run<RoleRow>(
        `UPDATE roles SET name = $1, role_key = $2, description = $3, permissions = $4::jsonb
         WHERE id = $5
         RETURNING id, name, role_key, description, permissions, is_system_role`,
        [input.name, input.roleKey, input.description, JSON.stringify(input.permissions), roleId]
      );
      await run(
        `UPDATE sessions SET revoked_at = NOW()
         WHERE revoked_at IS NULL
           AND user_id IN (SELECT user_id FROM user_assignments WHERE role_id = $1)`,
        [roleId]
      );
      await run(
        `DELETE FROM cashier_outlet_sessions cos
         USING user_assignments ua
         WHERE ua.role_id = $1 AND cos.user_id = ua.user_id`,
        [roleId]
      );
      await run(
        `INSERT INTO audit_log (company_id, actor_user_id, action_type, resource_type, resource_id, payload_before, payload_after)
         VALUES ($1, $2, 'ROLE.UPDATE', 'roles', $3, $4::jsonb, $5::jsonb)`,
        [
          auth.bundle.company.id, auth.userId, roleId,
          JSON.stringify({ name: role.name, role_key: role.role_key, permissions: role.permissions }),
          JSON.stringify({ name: updated.rows[0].name, role_key: updated.rows[0].role_key, permissions: updated.rows[0].permissions }),
        ]
      );
      return { outcome: "updated" as const, role: updated.rows[0] };
    });

    if (result.outcome === "not_found") return NextResponse.json({ success: false, message: "Custom role not found." }, { status: 404 });
    if (result.outcome === "out_of_scope") {
      return NextResponse.json({ success: false, message: "This role is assigned outside the properties you manage." }, { status: 403 });
    }
    if (result.outcome === "self_assignment") {
      return NextResponse.json({ success: false, message: "You cannot edit the permissions of a role assigned to your own account." }, { status: 403 });
    }
    if (result.outcome === "duplicate") return NextResponse.json({ success: false, message: "A role with that name already exists." }, { status: 409 });
    return NextResponse.json({ success: true, role: result.role, message: "Role updated. Assigned users must sign in again for the new permissions." });
  } catch (error) {
    console.error("Failed to update role.", error);
    return NextResponse.json({ success: false, message: "The role could not be updated." }, { status: 500 });
  }
}
