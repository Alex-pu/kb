import { NextResponse } from "next/server";
import { databaseReady, withUserContext } from "@/lib/db/postgres";
import { assertOutletAccess, getAuthContext, hasPermission } from "@/lib/auth/require-session";
import { businessDateForCountry } from "@/lib/utils/business-date";
import type { ShiftArea, ShiftPeriod } from "@/lib/types/database";
import type { QueryResultRow } from "pg";

export const runtime = "nodejs";

interface ShiftRow extends QueryResultRow {
  id: string;
  outlet_id: string;
  station_id: string;
  cashier_id: string;
  shift_area: ShiftArea | null;
  shift_period: ShiftPeriod | null;
  business_date: string | null;
  opening_float: string;
  cash_sales: string;
  status: "open" | "closed";
  opened_at: string;
  closed_at: string | null;
  counted_cash: string | null;
  variance: string | null;
}

function serializeShift(row: ShiftRow) {
  return {
    id: row.id,
    outlet_id: row.outlet_id,
    station_id: row.station_id,
    cashier_id: row.cashier_id,
    shift_area: row.shift_area,
    shift_period: row.shift_period,
    business_date: row.business_date,
    opening_float: Number(row.opening_float),
    cash_sales: Number(row.cash_sales),
    status: row.status,
    opened_at: row.opened_at,
    closed_at: row.closed_at ?? undefined,
    counted_cash: row.counted_cash != null ? Number(row.counted_cash) : undefined,
    variance: row.variance != null ? Number(row.variance) : undefined,
  };
}

export async function GET(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });

  const stationId = new URL(request.url).searchParams.get("station_id");
  const area = new URL(request.url).searchParams.get("area");
  if (!stationId || (area !== "pos" && area !== "reservation")) {
    return NextResponse.json({ success: false, message: "station_id and a valid area are required." }, { status: 400 });
  }
  const station = auth.bundle.stations.find((candidate) => candidate.id === stationId);
  if (!station) {
    return NextResponse.json({ success: false, message: "You are not assigned to this station." }, { status: 403 });
  }

  const shift = await withUserContext(auth.userId, async (run) => {
    const result = await run<ShiftRow>(
      `SELECT * FROM shifts
       WHERE outlet_id = $1 AND status = 'open'
         AND (shift_area = $2 OR ($2 = 'pos' AND shift_area IS NULL))
       ORDER BY opened_at DESC LIMIT 1`,
      [station.outlet_id, area]
    );
    return result.rows[0] ?? null;
  });

  return NextResponse.json({ success: true, shift: shift ? serializeShift(shift) : null });
}

interface OpenShiftBody {
  outlet_id?: string;
  station_id?: string;
  opening_float?: number;
  area?: ShiftArea;
  period?: ShiftPeriod;
  business_date?: string;
}

export async function POST(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });

  let body: OpenShiftBody;
  try {
    body = (await request.json()) as OpenShiftBody;
  } catch {
    return NextResponse.json({ success: false, message: "Request body must be valid JSON." }, { status: 400 });
  }

  if (!body.outlet_id || !body.station_id ||
      (body.area !== "pos" && body.area !== "reservation") ||
      (body.period !== "morning" && body.period !== "evening") ||
      typeof body.business_date !== "string" ||
      typeof body.opening_float !== "number" || !Number.isFinite(body.opening_float) || body.opening_float < 0) {
    return NextResponse.json({ success: false, message: "Outlet, station, area, shift period, today's business date, and a non-negative opening float are required." }, { status: 400 });
  }
  const today = businessDateForCountry(auth.bundle.company.country_code);
  if (body.business_date !== today) {
    return NextResponse.json({ success: false, message: `Shift date must be today (${today}).` }, { status: 400 });
  }

  const scope = assertOutletAccess(auth.bundle, body.outlet_id);
  if (!scope) return NextResponse.json({ success: false, message: "You are not assigned to this outlet." }, { status: 403 });
  if (!auth.bundle.stations.some((station) => station.id === body.station_id && station.outlet_id === body.outlet_id)) {
    return NextResponse.json({ success: false, message: "You are not assigned to this station." }, { status: 403 });
  }
  if (!hasPermission(auth.bundle, scope.propertyId, "shift:open")) {
    return NextResponse.json({ success: false, message: "Only the cashier (or a manager override) can open a shift." }, { status: 403 });
  }

  try {
    const shift = await withUserContext(auth.userId, async (run) => {
      const existing = await run<ShiftRow>(
        `SELECT * FROM shifts
         WHERE outlet_id = $1 AND status = 'open'
           AND (shift_area = $2 OR ($2 = 'pos' AND shift_area IS NULL))
         LIMIT 1`,
        [body.outlet_id, body.area]
      );
      if (existing.rows[0]) return { already: true as const, row: existing.rows[0] };

      const result = await run<ShiftRow>(
        `INSERT INTO shifts (property_id, outlet_id, station_id, cashier_id, shift_area, shift_period, business_date, opening_float)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [scope.propertyId, body.outlet_id, body.station_id, auth.userId, body.area, body.period, body.business_date, body.opening_float]
      );
      await run(
        `INSERT INTO audit_log (company_id, property_id, outlet_id, actor_user_id, action_type, resource_type, resource_id)
         VALUES ($1, $2, $3, $4, $5, 'shifts', $6)`,
        [
          auth.bundle.company.id,
          scope.propertyId,
          body.outlet_id,
          auth.userId,
          body.area === "pos" ? "SHIFT.OPEN" : "RESERVATION_SHIFT.OPEN",
          result.rows[0].id,
        ]
      );
      return { already: false as const, row: result.rows[0] };
    });

    if (shift.already) {
      return NextResponse.json({ success: false, message: `A ${body.area} shift is already open for this outlet.` }, { status: 409 });
    }

    return NextResponse.json({ success: true, message: "Shift opened.", shift: serializeShift(shift.row) });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      return NextResponse.json({ success: false, message: "A shift for this area and period has already been recorded today." }, { status: 409 });
    }
    console.error("Failed to open cashier shift.", error);
    return NextResponse.json({ success: false, message: "The shift could not be opened." }, { status: 500 });
  }
}
