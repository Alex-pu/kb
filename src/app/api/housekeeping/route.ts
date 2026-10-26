import { NextResponse } from "next/server";
import type { QueryResultRow } from "pg";
import { getAuthContext, hasPermission } from "@/lib/auth/require-session";
import { databaseReady, withUserContext } from "@/lib/db/postgres";

export const runtime = "nodejs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Checklist = Record<string, boolean>;

interface ChecklistItemRow extends QueryResultRow {
  item_key: string;
  label: string;
  sort_order: number;
}

interface JobRow extends QueryResultRow {
  id: string;
  room_id: string;
  room_number: string;
  floor: string;
  room_status: string;
  housekeeping_status: string;
  room_type_name: string;
  assigned_to: string | null;
  assignee_name: string | null;
  status: "pending" | "in_progress" | "completed";
  checklist: Checklist;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

interface StaffRow extends QueryResultRow {
  id: string;
  full_name: string;
  role_name: string;
  permissions: string[];
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseChecklist(value: unknown, itemKeys: readonly string[]): Checklist | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).length !== itemKeys.length || itemKeys.some((key) => typeof candidate[key] !== "boolean")) return null;
  return Object.fromEntries(itemKeys.map((key) => [key, candidate[key]])) as Checklist;
}

function errorResponse(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "23505") return NextResponse.json({ success: false, message: "This room already has an active housekeeping task." }, { status: 409 });
  console.error("Housekeeping API request failed.", error);
  return NextResponse.json({ success: false, message: "The housekeeping operation could not be completed." }, { status: 500 });
}

export async function GET(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });
  const propertyId = new URL(request.url).searchParams.get("property_id") || "";
  if (!UUID_PATTERN.test(propertyId)) return NextResponse.json({ success: false, message: "A valid property_id is required." }, { status: 400 });
  if (!hasPermission(auth.bundle, propertyId, "housekeeping:write")) {
    return NextResponse.json({ success: false, message: "You do not have permission to view housekeeping tasks." }, { status: 403 });
  }

  try {
    const data = await withUserContext(auth.userId, async (run) => {
      const [jobsResult, staffResult, checklistResult] = await Promise.all([
        run<JobRow>(
          `SELECT j.id, j.room_id, r.room_number, r.floor, r.status AS room_status,
                  r.housekeeping_status, rt.name AS room_type_name, j.assigned_to,
                  assignee.full_name AS assignee_name, j.status, j.checklist, j.notes,
                  j.created_at, j.updated_at
           FROM room_housekeeping_jobs j
           JOIN rooms r ON r.id = j.room_id AND r.property_id = j.property_id
           JOIN room_types rt ON rt.id = r.room_type_id AND rt.property_id = r.property_id
           LEFT JOIN users assignee ON assignee.id = j.assigned_to
           WHERE j.property_id = $1 AND j.status <> 'completed'
             AND ($3::boolean OR j.assigned_to = $2)
           ORDER BY CASE WHEN j.assigned_to = $2 THEN 0 WHEN j.assigned_to IS NULL THEN 1 ELSE 2 END,
                    j.created_at, r.room_number`,
          [propertyId, auth.userId, hasPermission(auth.bundle, propertyId, "housekeeping:manage")],
        ),
        hasPermission(auth.bundle, propertyId, "housekeeping:manage")
          ? run<StaffRow>(
          `SELECT DISTINCT u.id, u.full_name, role.name AS role_name, role.permissions
           FROM users u
           JOIN user_assignments assignment ON assignment.user_id = u.id
           JOIN roles role ON role.id = assignment.role_id
           WHERE assignment.property_id = $1 AND assignment.is_active = TRUE AND u.is_active = TRUE
             AND (
               role.permissions ? 'housekeeping:write' OR
               role.permissions ? 'housekeeping:manage' OR
               role.permissions ? '*'
             )
           ORDER BY u.full_name, role.name`,
          [propertyId],
           )
           : Promise.resolve({ rows: [] as StaffRow[] }),
        run<ChecklistItemRow>(
          `SELECT item_key, label, sort_order
           FROM housekeeping_checklist_items
           WHERE property_id = $1
           ORDER BY sort_order, item_key`,
          [propertyId],
        ),
      ]);
      return { jobs: jobsResult.rows, staff: staffResult.rows, checklistItems: checklistResult.rows };
    });
    return NextResponse.json({
      success: true,
      jobs: data.jobs.map((job) => ({
        id: job.id,
        room_id: job.room_id,
        room_number: job.room_number,
        floor: job.floor,
        room_status: job.room_status,
        housekeeping_status: job.housekeeping_status,
        room_type_name: job.room_type_name,
        assigned_to: job.assigned_to,
        assignee_name: job.assignee_name,
        status: job.status,
        checklist: job.checklist,
        notes: job.notes ?? "",
        created_at: job.created_at.toISOString(),
        updated_at: job.updated_at.toISOString(),
      })),
      staff: data.staff.map((person) => ({
        id: person.id,
        full_name: person.full_name,
        role_name: person.role_name,
      })),
      checklist_items: data.checklistItems,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });
  const body = await readBody(request);
  if (!body) return NextResponse.json({ success: false, message: "Request body must be a valid JSON object." }, { status: 400 });

  const propertyId = typeof body.property_id === "string" ? body.property_id : "";
  const jobId = typeof body.job_id === "string" ? body.job_id : "";
  const action = body.action;
  if (!UUID_PATTERN.test(propertyId) ||
      (action !== "assign" && action !== "start" && action !== "checklist" && action !== "notes" && action !== "ready" && action !== "save_checklist_template")) {
    return NextResponse.json({ success: false, message: "A valid property, task, and housekeeping action are required." }, { status: 400 });
  }
  if (!hasPermission(auth.bundle, propertyId, "housekeeping:write")) {
    return NextResponse.json({ success: false, message: "You do not have permission to update housekeeping tasks." }, { status: 403 });
  }

  if (action === "save_checklist_template") {
    if (!hasPermission(auth.bundle, propertyId, "housekeeping:manage")) {
      return NextResponse.json({ success: false, message: "Only a housekeeping supervisor can manage the room checklist." }, { status: 403 });
    }
    const rawItems = body.checklist_items;
    if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 30) {
      return NextResponse.json({ success: false, message: "A room checklist must contain between 1 and 30 items." }, { status: 400 });
    }
    const items: { item_key: string; label: string }[] = [];
    const itemKeys = new Set<string>();
    for (const rawItem of rawItems) {
      if (typeof rawItem !== "object" || rawItem === null || Array.isArray(rawItem)) {
        return NextResponse.json({ success: false, message: "Each checklist item needs a valid label and identifier." }, { status: 400 });
      }
      const candidate = rawItem as Record<string, unknown>;
      const itemKey = typeof candidate.item_key === "string" ? candidate.item_key : "";
      const label = typeof candidate.label === "string" ? candidate.label.trim() : "";
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(itemKey) || !label || label.length > 160 || itemKeys.has(itemKey)) {
        return NextResponse.json({ success: false, message: "Checklist labels must be unique and between 1 and 160 characters." }, { status: 400 });
      }
      itemKeys.add(itemKey);
      items.push({ item_key: itemKey, label });
    }

    try {
      await withUserContext(auth.userId, async (run) => {
        await run("DELETE FROM housekeeping_checklist_items WHERE property_id = $1", [propertyId]);
        for (const [sortOrder, item] of items.entries()) {
          await run(
            `INSERT INTO housekeeping_checklist_items (property_id, item_key, label, sort_order)
             VALUES ($1, $2, $3, $4)`,
            [propertyId, item.item_key, item.label, sortOrder],
          );
        }
        await run(
          `UPDATE room_housekeeping_jobs job
           SET checklist = COALESCE((
             SELECT jsonb_object_agg(item.item_key, COALESCE(job.checklist -> item.item_key, 'false'::jsonb))
             FROM housekeeping_checklist_items item
             WHERE item.property_id = job.property_id
           ), '{}'::jsonb), updated_at = NOW()
           WHERE job.property_id = $1 AND job.status <> 'completed'`,
          [propertyId],
        );
      });
      return NextResponse.json({ success: true, message: "Room housekeeping checklist saved." });
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (!UUID_PATTERN.test(jobId)) {
    return NextResponse.json({ success: false, message: "A valid housekeeping task is required." }, { status: 400 });
  }

  try {
    const result = await withUserContext(auth.userId, async (run) => {
      const jobResult = await run<{
        id: string;
        room_id: string;
        room_number: string;
        room_status: string;
        status: "pending" | "in_progress" | "completed";
        assigned_to: string | null;
        checklist: Checklist;
      }>(
        `SELECT j.id, j.room_id, r.room_number, r.status AS room_status, j.status, j.assigned_to, j.checklist
         FROM room_housekeeping_jobs j
         JOIN rooms r ON r.id = j.room_id AND r.property_id = j.property_id
         WHERE j.id = $1 AND j.property_id = $2
         FOR UPDATE OF j, r`,
        [jobId, propertyId],
      );
      const job = jobResult.rows[0];
      if (!job || job.status === "completed") return { outcome: "not_found" as const };
      const checklistItemsResult = await run<ChecklistItemRow>(
        "SELECT item_key FROM housekeeping_checklist_items WHERE property_id = $1 ORDER BY sort_order, item_key",
        [propertyId],
      );
      const checklistKeys = checklistItemsResult.rows.map((item) => item.item_key);

      if (action === "assign") {
        if (!hasPermission(auth.bundle, propertyId, "housekeeping:manage")) return { outcome: "forbidden" as const };
        const staffId = typeof body.staff_id === "string" ? body.staff_id : "";
        if (!UUID_PATTERN.test(staffId)) return { outcome: "invalid_staff" as const };
        const staff = await run<{ id: string }>(
          `SELECT u.id
           FROM users u
           JOIN user_assignments assignment ON assignment.user_id = u.id
           JOIN roles role ON role.id = assignment.role_id
           WHERE u.id = $1 AND u.is_active = TRUE AND assignment.property_id = $2
             AND assignment.is_active = TRUE
             AND (
               role.permissions ? 'housekeeping:write' OR
               role.permissions ? 'housekeeping:manage' OR
               role.permissions ? '*'
             )
           LIMIT 1`,
          [staffId, propertyId],
        );
        if (!staff.rows[0]) return { outcome: "invalid_staff" as const };
        await run(
          `UPDATE room_housekeeping_jobs SET assigned_to = $3, updated_at = NOW()
           WHERE id = $1 AND property_id = $2`,
          [jobId, propertyId, staffId],
        );
        await run(
          `INSERT INTO audit_log (company_id, property_id, actor_user_id, action_type, resource_type, resource_id, payload_after)
           VALUES ($1, $2, $3, 'HOUSEKEEPING.ASSIGN', 'room_housekeeping_jobs', $4, $5::jsonb)`,
          [auth.bundle.company.id, propertyId, auth.userId, jobId,
            JSON.stringify({ room_id: job.room_id, assigned_to: staffId })],
        );
        return { outcome: "assigned" as const, room: job.room_number };
      }

      if (job.assigned_to !== auth.userId && !hasPermission(auth.bundle, propertyId, "housekeeping:manage")) {
        return { outcome: "not_assigned" as const };
      }
      if (job.room_status === "occupied" || job.room_status === "maintenance") {
        return { outcome: "room_unavailable" as const, room: job.room_number };
      }

      if (action === "start") {
        if (job.status !== "pending") return { outcome: "wrong_state" as const };
        await run(
          `UPDATE room_housekeeping_jobs SET status = 'in_progress', updated_at = NOW()
           WHERE id = $1 AND property_id = $2`,
          [jobId, propertyId],
        );
        await run(
          `UPDATE rooms SET housekeeping_status = 'cleaning', housekeeping_updated_at = NOW(),
                  housekeeping_updated_by = $3, updated_at = NOW()
           WHERE id = $1 AND property_id = $2`,
          [job.room_id, propertyId, auth.userId],
        );
        return { outcome: "started" as const, room: job.room_number };
      }

      if (action === "checklist") {
        const checklist = parseChecklist(body.checklist, checklistKeys);
        if (!checklist) return { outcome: "invalid_checklist" as const };
        if (job.status !== "in_progress") return { outcome: "wrong_state" as const };
        await run(
          `UPDATE room_housekeeping_jobs SET checklist = $3::jsonb, updated_at = NOW()
           WHERE id = $1 AND property_id = $2`,
          [jobId, propertyId, JSON.stringify(checklist)],
        );
        return { outcome: "checklist_saved" as const, room: job.room_number };
      }

      if (action === "notes") {
        const notes = typeof body.notes === "string" ? body.notes.trim() : null;
        if (notes === null || notes.length > 1000) return { outcome: "invalid_notes" as const };
        await run(
          `UPDATE room_housekeeping_jobs SET notes = $3, updated_at = NOW()
           WHERE id = $1 AND property_id = $2`,
          [jobId, propertyId, notes || null],
        );
        return { outcome: "notes_saved" as const, room: job.room_number };
      }

      if (job.status !== "in_progress" || checklistKeys.some((item) => job.checklist[item] !== true)) {
        return { outcome: "checklist_incomplete" as const };
      }
      await run(
        `UPDATE room_housekeeping_jobs
         SET status = 'completed', completed_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND property_id = $2`,
        [jobId, propertyId],
      );
      await run(
        `UPDATE rooms
         SET housekeeping_status = 'ready', housekeeping_updated_at = NOW(),
             housekeeping_updated_by = $3, updated_at = NOW()
         WHERE id = $1 AND property_id = $2`,
        [job.room_id, propertyId, auth.userId],
      );
      return { outcome: "ready" as const, room: job.room_number };
    });

    if (result.outcome === "not_found") return NextResponse.json({ success: false, message: "Active housekeeping task not found." }, { status: 404 });
    if (result.outcome === "forbidden") return NextResponse.json({ success: false, message: "Only a housekeeping supervisor can assign rooms." }, { status: 403 });
    if (result.outcome === "invalid_staff") return NextResponse.json({ success: false, message: "Choose an active housekeeping staff member assigned to this property." }, { status: 400 });
    if (result.outcome === "not_assigned") return NextResponse.json({ success: false, message: "This task is assigned to another housekeeping staff member." }, { status: 403 });
    if (result.outcome === "room_unavailable") return NextResponse.json({ success: false, message: `Room ${result.room} cannot be processed while occupied or under maintenance.` }, { status: 409 });
    if (result.outcome === "wrong_state") return NextResponse.json({ success: false, message: "Start the assigned cleaning task before updating its checklist." }, { status: 409 });
    if (result.outcome === "invalid_checklist") return NextResponse.json({ success: false, message: "Every current checklist answer must be provided." }, { status: 400 });
    if (result.outcome === "invalid_notes") return NextResponse.json({ success: false, message: "Notes must be no more than 1,000 characters." }, { status: 400 });
    if (result.outcome === "checklist_incomplete") return NextResponse.json({ success: false, message: "Complete every room-readiness check before marking the room ready." }, { status: 409 });
    const messages = {
      assigned: `Room ${result.room} assigned to housekeeping.`,
      started: `Cleaning started for room ${result.room}.`,
      checklist_saved: `Checklist saved for room ${result.room}.`,
      notes_saved: `Notes saved for room ${result.room}.`,
      ready: `Room ${result.room} passed its checklist and is ready for booking.`,
    };
    return NextResponse.json({ success: true, message: messages[result.outcome] });
  } catch (error) {
    return errorResponse(error);
  }
}
