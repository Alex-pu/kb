import { NextResponse } from "next/server";
import type { QueryResultRow } from "pg";
import { getAuthContext, hasPermission } from "@/lib/auth/require-session";
import type { AuthContext } from "@/lib/auth/require-session";
import { databaseReady, withUserContext } from "@/lib/db/postgres";

export const runtime = "nodejs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_AMOUNT = 10_000_000;

interface EmployeeRow extends QueryResultRow {
  id: string;
  employee_code: string | null;
  full_name: string;
  department: string;
  phone: string | null;
  daily_rate: string;
  status: "active" | "inactive";
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

interface FolioRow extends QueryResultRow {
  id: string;
  folio_number: number;
  week_start: string;
  week_end: string;
  prepared_by: string | null;
  checked_by: string | null;
  approved_by: string | null;
  created_at: Date;
}

interface EntryRow extends QueryResultRow {
  id: string;
  employee_id: string;
  employee_code: string | null;
  employee_name: string;
  department: string;
  phone: string | null;
  work_days: string[];
  daily_rate: string;
  deductions: string;
  amount_paid: string;
  gross_pay: string;
  net_pay: string;
  balance_owed: string;
  payment_status: string;
  signature: string | null;
  notes: string | null;
}

type PayrollAccess =
  | { auth: AuthContext; propertyId: string }
  | { response: NextResponse };

function isPayrollRole(roleKey: string | undefined) {
  return ["admin", "administrator", "super_admin", "general_manager", "accountant"]
    .includes(roleKey?.trim().toLowerCase() ?? "");
}

function readPayrollAccess(auth: AuthContext, propertyId: unknown): PayrollAccess {
  if (typeof propertyId !== "string" || !UUID_PATTERN.test(propertyId) ||
      !auth.bundle.properties.some((property) => property.id === propertyId)) {
    return { response: NextResponse.json({ success: false, message: "Select a property you are assigned to." }, { status: 403 }) };
  }
  const hasPayrollRole = auth.bundle.assignments.some((assignment) =>
    assignment.property_id === propertyId && assignment.is_active && isPayrollRole(assignment.role?.role_key)
  );
  if (!hasPayrollRole || !hasPermission(auth.bundle, propertyId, "payroll:manage")) {
    return { response: NextResponse.json({ success: false, message: "Casual payroll is available to administrators and accountants only." }, { status: 403 }) };
  }
  return { auth, propertyId };
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isSunday(value: string) {
  return new Date(`${value}T00:00:00.000Z`).getUTCDay() === 0;
}

function validText(value: unknown, maxLength: number, required = false): value is string {
  return typeof value === "string" &&
    (!required || value.trim().length > 0) &&
    value.trim().length <= maxLength;
}

function validMoney(value: unknown, allowZero: boolean): value is number {
  return typeof value === "number" && Number.isFinite(value) &&
    (allowZero ? value >= 0 : value > 0) && value <= MAX_AMOUNT &&
    Math.abs(Math.round(value * 100) - value * 100) < 0.000001;
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function employeeInput(body: Record<string, unknown>) {
  const optionalText = (value: unknown, maxLength: number): string | null => {
    if (value === undefined || value === null) return "";
    if (typeof value !== "string" || value.trim().length > maxLength) return null;
    return value.trim();
  };
  const employeeCode = optionalText(body.employee_code, 100);
  const phone = optionalText(body.phone, 50);
  const notes = optionalText(body.notes, 2000);
  if (!validText(body.full_name, 200, true) ||
      !validText(body.department, 100, true) ||
      !validMoney(body.daily_rate, false) ||
      employeeCode === null ||
      phone === null ||
      notes === null ||
      (body.status !== "active" && body.status !== "inactive")) return null;
  return {
    employeeCode: employeeCode || null,
    fullName: body.full_name.trim(),
    department: body.department.trim(),
    phone: phone || null,
    dailyRate: body.daily_rate,
    status: body.status,
    notes: notes || null,
  };
}

interface EntryInput {
  employeeId: string;
  workDays: string[];
  deductions: number;
  amountPaid: number;
  signature: string | null;
  notes: string | null;
}

function parseEntryInputs(value: unknown): EntryInput[] | null {
  if (!Array.isArray(value) || value.length > 1000) return null;
  const result: EntryInput[] = [];
  const employeeIds = new Set<string>();
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const entry = item as Record<string, unknown>;
    if (typeof entry.employee_id !== "string" || !UUID_PATTERN.test(entry.employee_id) ||
        employeeIds.has(entry.employee_id) ||
        !Array.isArray(entry.work_days) || entry.work_days.length > 7 ||
        !entry.work_days.every(isDate) ||
        new Set(entry.work_days).size !== entry.work_days.length ||
        !validMoney(entry.deductions, true) ||
        !validMoney(entry.amount_paid, true) ||
        (entry.signature !== undefined && entry.signature !== null && !validText(entry.signature, 200)) ||
        (entry.notes !== undefined && entry.notes !== null && !validText(entry.notes, 2000))) return null;
    employeeIds.add(entry.employee_id);
    result.push({
      employeeId: entry.employee_id,
      workDays: entry.work_days as string[],
      deductions: entry.deductions,
      amountPaid: entry.amount_paid,
      signature: typeof entry.signature === "string" ? entry.signature.trim() || null : null,
      notes: typeof entry.notes === "string" ? entry.notes.trim() || null : null,
    });
  }
  return result;
}

function parseApprovalFields(body: Record<string, unknown>) {
  const fields = ["prepared_by", "checked_by", "approved_by"] as const;
  const approvals: Record<(typeof fields)[number], string | null> = {
    prepared_by: null,
    checked_by: null,
    approved_by: null,
  };
  for (const field of fields) {
    const value = body[field];
    if (value !== undefined && value !== null && !validText(value, 200)) return null;
    approvals[field] = typeof value === "string" ? value.trim() || null : null;
  }
  return approvals;
}

async function requireAuth() {
  if (!databaseReady()) {
    return { response: NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 }) } as const;
  }
  const auth = await getAuthContext();
  if (!auth) return { response: NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 }) } as const;
  return { auth } as const;
}

export async function GET(request: Request) {
  const access = await requireAuth();
  if ("response" in access) return access.response;
  const url = new URL(request.url);
  const payrollAccess = readPayrollAccess(access.auth, url.searchParams.get("property_id"));
  if ("response" in payrollAccess) return payrollAccess.response;
  const { auth, propertyId } = payrollAccess;
  const weekStart = url.searchParams.get("week_start");
  if (weekStart !== null && (!isDate(weekStart) || !isSunday(weekStart))) {
    return NextResponse.json({ success: false, message: "Choose a Sunday as the first day of the payroll week." }, { status: 400 });
  }

  try {
    const result = await withUserContext(auth.userId, async (run) => {
      const [employees, folios] = await Promise.all([
        run<EmployeeRow>(
          `SELECT id, employee_code, full_name, department, phone, daily_rate::text,
                  status, notes, created_at, updated_at
           FROM casual_payroll_employees
           WHERE property_id = $1
           ORDER BY department, full_name`,
          [propertyId]
        ),
        run<FolioRow>(
          `WITH recent_folios AS (
             SELECT id, folio_number, to_char(week_start, 'YYYY-MM-DD') AS week_start,
                    to_char(week_end, 'YYYY-MM-DD') AS week_end, prepared_by, checked_by, approved_by, created_at
             FROM casual_payroll_folios
             WHERE property_id = $1
             ORDER BY week_start DESC
             LIMIT 52
           ),
           selected_folio AS (
             SELECT id, folio_number, to_char(week_start, 'YYYY-MM-DD') AS week_start,
                    to_char(week_end, 'YYYY-MM-DD') AS week_end, prepared_by, checked_by, approved_by, created_at
             FROM casual_payroll_folios
             WHERE property_id = $1 AND week_start = $2::date
           )
           SELECT * FROM recent_folios
           UNION
           SELECT * FROM selected_folio
           ORDER BY week_start DESC`,
          [propertyId, weekStart]
        ),
      ]);

      const folio = weekStart
        ? folios.rows.find((row) => row.week_start === weekStart) ?? null
        : null;
      const entries = folio
        ? await run<EntryRow>(
            `SELECT id, employee_id, employee_code, employee_name, department, phone,
                    array_to_json(work_days) AS work_days, daily_rate::text, deductions::text,
                    amount_paid::text, gross_pay::text, net_pay::text, balance_owed::text,
                    payment_status, signature, notes
             FROM casual_payroll_entries
             WHERE folio_id = $1 AND property_id = $2
             ORDER BY department, employee_name`,
            [folio.id, propertyId]
          )
        : { rows: [] as EntryRow[] };
      return { employees: employees.rows, folios: folios.rows, folio, entries: entries.rows };
    });
    return NextResponse.json({
      success: true,
      employees: result.employees.map((employee) => ({ ...employee, daily_rate: Number(employee.daily_rate) })),
      folios: result.folios,
      folio: result.folio,
      entries: result.entries.map((entry) => ({
        ...entry,
        work_days: entry.work_days ?? [],
        daily_rate: Number(entry.daily_rate),
        deductions: Number(entry.deductions),
        amount_paid: Number(entry.amount_paid),
        gross_pay: Number(entry.gross_pay),
        net_pay: Number(entry.net_pay),
        balance_owed: Number(entry.balance_owed),
      })),
    });
  } catch (error) {
    console.error("Failed to load casual payroll.", error);
    return NextResponse.json({ success: false, message: "Casual payroll could not be loaded." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const access = await requireAuth();
  if ("response" in access) return access.response;
  const body = await readBody(request);
  if (!body) return NextResponse.json({ success: false, message: "The request body is invalid." }, { status: 400 });
  const payrollAccess = readPayrollAccess(access.auth, body.property_id);
  if ("response" in payrollAccess) return payrollAccess.response;
  const { auth, propertyId } = payrollAccess;

  if (body.action === "create_employee") {
    const input = employeeInput(body);
    if (!input) return NextResponse.json({ success: false, message: "Enter a name, department, valid daily rate, and valid worker details." }, { status: 400 });
    try {
      const employee = await withUserContext(auth.userId, async (run) => {
        const inserted = await run<EmployeeRow>(
          `INSERT INTO casual_payroll_employees
             (company_id, property_id, employee_code, full_name, department, phone, daily_rate, status, notes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id, employee_code, full_name, department, phone, daily_rate::text,
                     status, notes, created_at, updated_at`,
          [auth.bundle.company.id, propertyId, input.employeeCode, input.fullName, input.department,
            input.phone, input.dailyRate, input.status, input.notes, auth.userId]
        );
        const row = inserted.rows[0];
        await run(
          `INSERT INTO audit_log
             (company_id, property_id, actor_user_id, action_type, resource_type, resource_id, payload_after)
           VALUES ($1, $2, $3, 'PAYROLL.EMPLOYEE.CREATE', 'casual_payroll_employees', $4, $5::jsonb)`,
          [auth.bundle.company.id, propertyId, auth.userId, row.id, JSON.stringify(input)]
        );
        return { ...row, daily_rate: Number(row.daily_rate) };
      });
      return NextResponse.json({ success: true, employee, message: "Worker added." }, { status: 201 });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        return NextResponse.json({ success: false, message: "That worker ID is already in use at this property." }, { status: 409 });
      }
      console.error("Failed to create casual payroll employee.", error);
      return NextResponse.json({ success: false, message: "The worker could not be added." }, { status: 500 });
    }
  }

  if (body.action === "create_folio") {
    if (!isDate(body.week_start) || !isSunday(body.week_start)) {
      return NextResponse.json({ success: false, message: "Choose a Sunday as the first day of the payroll week." }, { status: 400 });
    }
    try {
      const result = await withUserContext(auth.userId, async (run) => {
        await run("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [propertyId, body.week_start]);
        const existing = await run<FolioRow>(
          `SELECT id, folio_number, to_char(week_start, 'YYYY-MM-DD') AS week_start,
                  to_char(week_end, 'YYYY-MM-DD') AS week_end, prepared_by, checked_by, approved_by, created_at
           FROM casual_payroll_folios WHERE property_id = $1 AND week_start = $2`,
          [propertyId, body.week_start]
        );
        if (existing.rows[0]) return { folio: existing.rows[0], created: false };

        const counter = await run<{ folio_number: number }>(
          `INSERT INTO casual_payroll_folio_counters (property_id, next_number)
           VALUES ($1, 2)
           ON CONFLICT (property_id) DO UPDATE
             SET next_number = casual_payroll_folio_counters.next_number + 1
           RETURNING next_number - 1 AS folio_number`,
          [propertyId]
        );
        const inserted = await run<FolioRow>(
          `INSERT INTO casual_payroll_folios
             (company_id, property_id, folio_number, week_start, week_end, created_by)
           VALUES ($1, $2, $3, $4::date, $4::date + 6, $5)
           RETURNING id, folio_number, to_char(week_start, 'YYYY-MM-DD') AS week_start,
                     to_char(week_end, 'YYYY-MM-DD') AS week_end, prepared_by, checked_by, approved_by, created_at`,
          [auth.bundle.company.id, propertyId, counter.rows[0].folio_number, body.week_start, auth.userId]
        );
        const folio = inserted.rows[0];
        await run(
          `INSERT INTO audit_log
             (company_id, property_id, actor_user_id, action_type, resource_type, resource_id, payload_after)
           VALUES ($1, $2, $3, 'PAYROLL.FOLIO.CREATE', 'casual_payroll_folios', $4, $5::jsonb)`,
          [auth.bundle.company.id, propertyId, auth.userId, folio.id, JSON.stringify(folio)]
        );
        return { folio, created: true };
      });
      return NextResponse.json({ success: true, ...result, message: result.created ? "Weekly folio opened." : "This week already has a folio." }, { status: result.created ? 201 : 200 });
    } catch (error) {
      console.error("Failed to create casual payroll folio.", error);
      return NextResponse.json({ success: false, message: "The weekly folio could not be opened." }, { status: 500 });
    }
  }

  return NextResponse.json({ success: false, message: "Choose a supported payroll operation." }, { status: 400 });
}

export async function PATCH(request: Request) {
  const access = await requireAuth();
  if ("response" in access) return access.response;
  const body = await readBody(request);
  if (!body) return NextResponse.json({ success: false, message: "The request body is invalid." }, { status: 400 });
  const payrollAccess = readPayrollAccess(access.auth, body.property_id);
  if ("response" in payrollAccess) return payrollAccess.response;
  const { auth, propertyId } = payrollAccess;

  if (body.action === "update_employee") {
    if (typeof body.employee_id !== "string" || !UUID_PATTERN.test(body.employee_id)) {
      return NextResponse.json({ success: false, message: "Select a valid worker." }, { status: 400 });
    }
    const input = employeeInput(body);
    if (!input) return NextResponse.json({ success: false, message: "Enter a name, department, valid daily rate, and valid worker details." }, { status: 400 });
    try {
      const outcome = await withUserContext(auth.userId, async (run) => {
        const existing = await run<EmployeeRow>(
          `SELECT id, employee_code, full_name, department, phone, daily_rate::text,
                  status, notes, created_at, updated_at
           FROM casual_payroll_employees
           WHERE id = $1 AND property_id = $2
           FOR UPDATE`,
          [body.employee_id, propertyId]
        );
        const before = existing.rows[0];
        if (!before) return null;
        const updated = await run<EmployeeRow>(
          `UPDATE casual_payroll_employees
           SET employee_code = $1, full_name = $2, department = $3, phone = $4,
               daily_rate = $5, status = $6, notes = $7, updated_at = NOW()
           WHERE id = $8 AND property_id = $9
           RETURNING id, employee_code, full_name, department, phone, daily_rate::text,
                     status, notes, created_at, updated_at`,
          [input.employeeCode, input.fullName, input.department, input.phone, input.dailyRate,
            input.status, input.notes, body.employee_id, propertyId]
        );
        await run(
          `INSERT INTO audit_log
             (company_id, property_id, actor_user_id, action_type, resource_type, resource_id, payload_before, payload_after)
           VALUES ($1, $2, $3, 'PAYROLL.EMPLOYEE.UPDATE', 'casual_payroll_employees', $4, $5::jsonb, $6::jsonb)`,
          [auth.bundle.company.id, propertyId, auth.userId, body.employee_id,
            JSON.stringify(before), JSON.stringify(input)]
        );
        return { ...updated.rows[0], daily_rate: Number(updated.rows[0].daily_rate) };
      });
      if (!outcome) return NextResponse.json({ success: false, message: "Worker not found." }, { status: 404 });
      return NextResponse.json({ success: true, employee: outcome, message: "Worker details updated." });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        return NextResponse.json({ success: false, message: "That worker ID is already in use at this property." }, { status: 409 });
      }
      console.error("Failed to update casual payroll employee.", error);
      return NextResponse.json({ success: false, message: "The worker details could not be updated." }, { status: 500 });
    }
  }

  if (body.action === "save_folio") {
    if (typeof body.folio_id !== "string" || !UUID_PATTERN.test(body.folio_id)) {
      return NextResponse.json({ success: false, message: "Select a valid weekly folio." }, { status: 400 });
    }
    const entries = parseEntryInputs(body.entries);
    if (!entries) return NextResponse.json({ success: false, message: "One or more worker payment details are invalid." }, { status: 400 });
    const approvals = parseApprovalFields(body);
    if (!approvals) return NextResponse.json({ success: false, message: "Approval names must be 200 characters or fewer." }, { status: 400 });
    try {
      const outcome = await withUserContext(auth.userId, async (run) => {
        const folioResult = await run<FolioRow>(
          `SELECT id, folio_number, to_char(week_start, 'YYYY-MM-DD') AS week_start,
                  to_char(week_end, 'YYYY-MM-DD') AS week_end, prepared_by, checked_by, approved_by, created_at
           FROM casual_payroll_folios
           WHERE id = $1 AND property_id = $2
           FOR UPDATE`,
          [body.folio_id, propertyId]
        );
        const folio = folioResult.rows[0];
        if (!folio) return "not_found" as const;
        if (entries.some((entry) => entry.workDays.some((day) => day < folio.week_start || day > folio.week_end))) {
          return "invalid_days" as const;
        }

        const ids = entries.map((entry) => entry.employeeId);
        const employees = ids.length > 0
          ? await run<EmployeeRow>(
              `SELECT id, employee_code, full_name, department, phone, daily_rate::text,
                      status, notes, created_at, updated_at
               FROM casual_payroll_employees
               WHERE property_id = $1 AND id = ANY($2::uuid[])`,
              [propertyId, ids]
            )
          : { rows: [] as EmployeeRow[] };
        if (employees.rows.length !== ids.length) return "invalid_employee" as const;

        const currentEntries = await run<EntryRow>(
          `SELECT id, employee_id, employee_code, employee_name, department, phone,
                  array_to_json(work_days) AS work_days, daily_rate::text, deductions::text,
                  amount_paid::text, gross_pay::text, net_pay::text, balance_owed::text,
                  payment_status, signature, notes
           FROM casual_payroll_entries
           WHERE folio_id = $1 AND property_id = $2`,
          [folio.id, propertyId]
        );
        const previousByEmployee = new Map(currentEntries.rows.map((entry) => [entry.employee_id, entry]));
        const employeeById = new Map(employees.rows.map((employee) => [employee.id, employee]));
        for (const entry of entries) {
          const employee = employeeById.get(entry.employeeId);
          if (!employee) return "invalid_employee" as const;
          if (employee.status === "inactive" && !previousByEmployee.has(employee.id)) return "inactive_employee" as const;
          const previous = previousByEmployee.get(employee.id);
          await run(
            `INSERT INTO casual_payroll_entries
               (folio_id, property_id, employee_id, employee_code, employee_name, department, phone,
                work_days, daily_rate, deductions, amount_paid, signature, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date[], $9, $10, $11, $12, $13)
             ON CONFLICT (folio_id, employee_id) DO UPDATE SET
               employee_code = EXCLUDED.employee_code,
               employee_name = EXCLUDED.employee_name,
               department = EXCLUDED.department,
               phone = EXCLUDED.phone,
               work_days = EXCLUDED.work_days,
               daily_rate = EXCLUDED.daily_rate,
               deductions = EXCLUDED.deductions,
               amount_paid = EXCLUDED.amount_paid,
               signature = EXCLUDED.signature,
               notes = EXCLUDED.notes,
               updated_at = NOW()`,
            [folio.id, propertyId, employee.id, employee.employee_code, employee.full_name, employee.department,
              employee.phone, entry.workDays, previous ? Number(previous.daily_rate) : Number(employee.daily_rate),
              entry.deductions, entry.amountPaid, entry.signature, entry.notes]
          );
        }
        await run(
          `DELETE FROM casual_payroll_entries
           WHERE folio_id = $1 AND property_id = $2 AND employee_id <> ALL($3::uuid[])`,
          [folio.id, propertyId, ids]
        );
        const savedEntries = await run<EntryRow>(
          `SELECT id, employee_id, employee_code, employee_name, department, phone,
                  array_to_json(work_days) AS work_days, daily_rate::text, deductions::text,
                  amount_paid::text, gross_pay::text, net_pay::text, balance_owed::text,
                  payment_status, signature, notes
           FROM casual_payroll_entries
           WHERE folio_id = $1 AND property_id = $2
           ORDER BY department, employee_name`,
          [folio.id, propertyId]
        );
        await run(
          `UPDATE casual_payroll_folios
           SET prepared_by = $2, checked_by = $3, approved_by = $4, updated_at = NOW()
           WHERE id = $1`,
          [folio.id, approvals.prepared_by, approvals.checked_by, approvals.approved_by]
        );
        await run(
          `INSERT INTO audit_log
             (company_id, property_id, actor_user_id, action_type, resource_type, resource_id, payload_before, payload_after)
           VALUES ($1, $2, $3, 'PAYROLL.FOLIO.SAVE', 'casual_payroll_folios', $4, $5::jsonb, $6::jsonb)`,
          [auth.bundle.company.id, propertyId, auth.userId, folio.id,
              JSON.stringify({
                approvals: {
                  prepared_by: folio.prepared_by,
                  checked_by: folio.checked_by,
                  approved_by: folio.approved_by,
                },
                entries: currentEntries.rows,
              }),
              JSON.stringify({
                approvals,
                entries: savedEntries.rows.map((entry) => ({
                  employee_id: entry.employee_id,
                  work_days: entry.work_days,
                  daily_rate: entry.daily_rate,
                  deductions: entry.deductions,
                  amount_paid: entry.amount_paid,
                  signature: entry.signature,
                  notes: entry.notes,
                })),
              })]
        );
        return { folio, entries: savedEntries.rows };
      });
      if (outcome === "not_found") return NextResponse.json({ success: false, message: "Weekly folio not found." }, { status: 404 });
      if (outcome === "invalid_days") return NextResponse.json({ success: false, message: "Attendance days must fall within the selected payroll week." }, { status: 400 });
      if (outcome === "invalid_employee") return NextResponse.json({ success: false, message: "A selected worker no longer exists at this property." }, { status: 409 });
      if (outcome === "inactive_employee") return NextResponse.json({ success: false, message: "Inactive workers cannot be added to a new weekly folio." }, { status: 409 });
      return NextResponse.json({
        success: true,
        message: "Weekly folio saved.",
        entries: outcome.entries.map((entry) => ({
          ...entry,
          work_days: entry.work_days ?? [],
          daily_rate: Number(entry.daily_rate),
          deductions: Number(entry.deductions),
          amount_paid: Number(entry.amount_paid),
          gross_pay: Number(entry.gross_pay),
          net_pay: Number(entry.net_pay),
          balance_owed: Number(entry.balance_owed),
        })),
      });
    } catch (error) {
      console.error("Failed to save casual payroll folio.", error);
      return NextResponse.json({ success: false, message: "The weekly folio could not be saved." }, { status: 500 });
    }
  }

  return NextResponse.json({ success: false, message: "Choose a supported payroll operation." }, { status: 400 });
}
