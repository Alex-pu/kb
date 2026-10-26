import { NextResponse } from "next/server";
import type { QueryResultRow } from "pg";
import { getAuthContext, hasPermission } from "@/lib/auth/require-session";
import { databaseReady, withUserContext } from "@/lib/db/postgres";
import type { Booking, Folio, FolioLine, HousekeepingStatus, MealAddOn, Room, RoomChargeRequest, RoomStatus, RoomType, TenderLine } from "@/lib/types/database";

export const runtime = "nodejs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROOM_STATUSES = new Set<RoomStatus>(["available", "occupied", "reserved", "maintenance"]);
const MEAL_ADD_ONS = new Set<MealAddOn>(["breakfast", "lunch"]);
const TENDER_TYPES = new Set<TenderLine["type"]>(["cash", "mpesa", "card"]);

interface RoomTypeRow extends QueryResultRow {
  id: string;
  property_id: string;
  name: string;
  rate_per_night: string;
}

interface RoomRow extends QueryResultRow {
  id: string;
  property_id: string;
  room_type_id: string;
  room_number: string;
  floor: string;
  status: RoomStatus;
  housekeeping_status: HousekeepingStatus;
  housekeeping_updated_at: Date;
  housekeeping_updated_by_name: string | null;
  housekeeping_checklist: Room["housekeeping_checklist"] | null;
  housekeeping_notes: string | null;
}

interface BookingRow extends QueryResultRow {
  id: string;
  property_id: string;
  room_id: string;
  guest_name: string;
  guest_phone: string;
  guest_id_number: string | null;
  guest_count: number;
  meal_add_ons: Partial<Record<MealAddOn, number>>;
  check_in_date: string;
  check_out_date: string;
  status: Booking["status"];
  folio_id: string;
  actual_check_in: Date | null;
  actual_check_out: Date | null;
}

interface FolioLineRow extends QueryResultRow {
  id: string;
  type: FolioLine["type"];
  description: string;
  amount: string;
  reference: string | null;
  created_at: Date;
}

interface RoomChargeRequestRow extends QueryResultRow {
  id: string;
  check_id: string;
  booking_id: string;
  folio_id: string;
  outlet_id: string;
  table_ref: string;
  table_name: string;
  guest_name: string;
  amount: string;
  requested_by: string;
  requested_by_name: string;
  status: "pending" | "approved" | "rejected";
  reason: string | null;
  created_at: Date;
}

type MutationResult =
  | { success: true; message: string }
  | { success: false; status: number; message: string };

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

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maxLength;
}

function validMoney(value: unknown, allowZero = false): value is number {
  return typeof value === "number" && Number.isFinite(value) &&
    value <= 1_000_000 && (allowZero ? value >= 0 : value > 0) &&
    Math.abs(Math.round(value * 100) - value * 100) < 0.000001;
}

function parseMealAddOns(value: unknown): Partial<Record<MealAddOn, number>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.some(([name, rate]) => !MEAL_ADD_ONS.has(name as MealAddOn) || !validMoney(rate))) return null;
  return Object.fromEntries(entries) as Partial<Record<MealAddOn, number>>;
}

function parseTenders(value: unknown): TenderLine[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) return null;
  const tenders: TenderLine[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const line = item as Record<string, unknown>;
    if (typeof line.type !== "string" || !TENDER_TYPES.has(line.type as TenderLine["type"]) || !validMoney(line.amount)) return null;
    if (line.reference !== undefined && (typeof line.reference !== "string" || line.reference.length > 160)) return null;
    if (line.type === "mpesa" && (typeof line.reference !== "string" || !line.reference.trim())) return null;
    tenders.push({
      type: line.type as TenderLine["type"],
      amount: line.amount,
      reference: typeof line.reference === "string" ? line.reference.trim() : undefined,
    });
  }
  return tenders;
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function errorResponse(error: unknown, operation: string) {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "23505") {
    return NextResponse.json({ success: false, message: "A room type or room with that name/number already exists in this property." }, { status: 409 });
  }
  if (code === "23503") {
    return NextResponse.json({ success: false, message: "The selected room type or room record is no longer available." }, { status: 409 });
  }
  console.error(`Room API ${operation} failed.`, error);
  return NextResponse.json({ success: false, message: "The room operation could not be completed. Please retry or contact an administrator." }, { status: 500 });
}

function resultResponse(result: MutationResult) {
  return NextResponse.json(
    { success: result.success, message: result.message },
    result.success ? undefined : { status: result.status },
  );
}

async function requireRoomProperty(request: Request) {
  const auth = await getAuthContext();
  if (!auth) {
    return { response: NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 }) } as const;
  }
  const propertyId = new URL(request.url).searchParams.get("property_id") || "";
  if (!UUID_PATTERN.test(propertyId)) {
    return { response: NextResponse.json({ success: false, message: "A valid property_id is required." }, { status: 400 }) } as const;
  }
  if (!hasPermission(auth.bundle, propertyId, "frontdesk:read") &&
      !hasPermission(auth.bundle, propertyId, "housekeeping:write")) {
    return { response: NextResponse.json({ success: false, message: "You do not have permission to view rooms in this property." }, { status: 403 }) } as const;
  }
  return { auth, propertyId } as const;
}

export async function GET(request: Request) {
  if (!databaseReady()) {
    return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  }
  const access = await requireRoomProperty(request);
  if ("response" in access) return access.response;

  try {
    const workspace = await withUserContext(access.auth.userId, async (run) => {
      const [roomTypesResult, roomsResult, bookingsResult, foliosResult, roomChargeRequestsResult] = await Promise.all([
        run<RoomTypeRow>(
          `SELECT id, property_id, name, rate_per_night
           FROM room_types WHERE property_id = $1
           ORDER BY name, id`,
          [access.propertyId],
        ),
        run<RoomRow>(
          `SELECT r.id, r.property_id, r.room_type_id, r.room_number, r.floor, r.status,
                  r.housekeeping_status, r.housekeeping_updated_at,
                  u.full_name AS housekeeping_updated_by_name,
                  latest_job.checklist AS housekeeping_checklist,
                  latest_job.notes AS housekeeping_notes
           FROM rooms r
           LEFT JOIN users u ON u.id = r.housekeeping_updated_by
           LEFT JOIN LATERAL (
             SELECT checklist, notes FROM room_housekeeping_jobs
             WHERE room_id = r.id AND property_id = r.property_id
             ORDER BY created_at DESC, id DESC LIMIT 1
           ) latest_job ON TRUE
           WHERE r.property_id = $1
           ORDER BY r.room_number, r.id`,
          [access.propertyId],
        ),
        run<BookingRow>(
          `SELECT b.id, b.property_id, b.room_id, b.guest_name, b.guest_phone, b.guest_id_number,
                  b.guest_count, b.meal_add_ons, b.check_in_date::text, b.check_out_date::text,
                  b.status, f.id AS folio_id, b.actual_check_in, b.actual_check_out
           FROM room_bookings b
           JOIN room_folios f ON f.booking_id = b.id AND f.property_id = b.property_id
           WHERE b.property_id = $1
           ORDER BY b.created_at DESC, b.id DESC`,
          [access.propertyId],
        ),
        run<{
          id: string;
          booking_id: string;
          lines: Array<Omit<FolioLine, "amount"> & { amount: number | string }>;
        }>(
          `SELECT f.id, f.booking_id,
                  COALESCE(
                    jsonb_agg(jsonb_build_object(
                      'id', l.id,
                      'type', l.type,
                      'description', l.description,
                      'amount', l.amount,
                      'reference', l.reference,
                      'created_at', l.created_at
                    ) ORDER BY l.created_at, l.id) FILTER (WHERE l.id IS NOT NULL),
                    '[]'::jsonb
                  ) AS lines
           FROM room_folios f
           LEFT JOIN room_folio_lines l ON l.folio_id = f.id AND l.property_id = f.property_id
           WHERE f.property_id = $1
           GROUP BY f.id, f.booking_id`,
          [access.propertyId],
        ),
        hasPermission(access.auth.bundle, access.propertyId, "frontdesk:read")
          ? run<RoomChargeRequestRow>(
            `SELECT r.id, r.check_id, r.booking_id, r.folio_id, r.outlet_id,
                    r.table_ref, r.table_name, r.guest_name, r.amount, r.requested_by,
                    u.full_name AS requested_by_name, r.status, r.reason, r.created_at
             FROM restaurant_room_charge_requests r
             JOIN users u ON u.id = r.requested_by
             WHERE r.property_id = $1 AND r.status = 'pending'
             ORDER BY r.created_at, r.id`,
            [access.propertyId],
          )
          : Promise.resolve({ rows: [] as RoomChargeRequestRow[] }),
      ]);

      const roomTypes: RoomType[] = roomTypesResult.rows.map((row) => ({
        id: row.id,
        property_id: row.property_id,
        name: row.name,
        rate_per_night: Number(row.rate_per_night),
      }));
      const rooms: Room[] = roomsResult.rows.map((row) => ({
        id: row.id,
        property_id: row.property_id,
        room_type_id: row.room_type_id,
        number: row.room_number,
        floor: row.floor,
        status: row.status,
        housekeeping_status: row.housekeeping_status,
        housekeeping_updated_at: row.housekeeping_updated_at.toISOString(),
        housekeeping_updated_by_name: row.housekeeping_updated_by_name || undefined,
        housekeeping_checklist: row.housekeeping_checklist ?? undefined,
        housekeeping_notes: row.housekeeping_notes ?? undefined,
      }));
      const bookings: Booking[] = bookingsResult.rows.map((row) => ({
        id: row.id,
        property_id: row.property_id,
        room_id: row.room_id,
        guest: {
          id: row.id,
          full_name: row.guest_name,
          phone_number: row.guest_phone,
          id_number: row.guest_id_number || undefined,
        },
        check_in_date: row.check_in_date,
        check_out_date: row.check_out_date,
        status: row.status,
        folio_id: row.folio_id,
        guest_count: row.guest_count,
        meal_add_ons: row.meal_add_ons,
        actual_check_in: row.actual_check_in?.toISOString(),
        actual_check_out: row.actual_check_out?.toISOString(),
      }));
      const folios: Folio[] = foliosResult.rows.map((row) => ({
        id: row.id,
        booking_id: row.booking_id,
        lines: row.lines.map((line) => ({
          ...line,
          amount: Number(line.amount),
        })),
      }));

      const roomChargeRequests: RoomChargeRequest[] = roomChargeRequestsResult.rows.map((row) => ({
        id: row.id,
        check_id: row.check_id,
        booking_id: row.booking_id,
        folio_id: row.folio_id,
        outlet_id: row.outlet_id,
        table_id: row.table_ref,
        table_name: row.table_name,
        guest_name: row.guest_name,
        amount: Number(row.amount),
        requested_by_user_id: row.requested_by,
        requested_by_name: row.requested_by_name,
        status: row.status,
        reason: row.reason || undefined,
        created_at: row.created_at.toISOString(),
      }));

      return { roomTypes, rooms, bookings, folios, roomChargeRequests };
    });

    return NextResponse.json({ success: true, ...workspace });
  } catch (error) {
    return errorResponse(error, "GET");
  }
}

export async function POST(request: Request) {
  if (!databaseReady()) {
    return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  }
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });
  const body = await readBody(request);
  if (!body) return NextResponse.json({ success: false, message: "Request body must be a valid JSON object." }, { status: 400 });

  const propertyId = typeof body.property_id === "string" ? body.property_id : "";
  const action = typeof body.action === "string" ? body.action : "";
  if (!UUID_PATTERN.test(propertyId)) {
    return NextResponse.json({ success: false, message: "A valid property_id is required." }, { status: 400 });
  }

  const canManageRoomSetup = hasPermission(auth.bundle, propertyId, "rooms:manage");
  const canManageFrontDesk = hasPermission(auth.bundle, propertyId, "frontdesk:write");
  if ((action === "create_room_type" || action === "create_room") && !canManageRoomSetup) {
    return NextResponse.json({ success: false, message: "You do not have permission to manage room setup." }, { status: 403 });
  }
  if (action !== "create_room_type" && action !== "create_room" &&
      action !== "create_booking" &&
      action !== "check_in" && action !== "check_out" &&
      action !== "folio_charge" && action !== "folio_payment") {
    return NextResponse.json({ success: false, message: "A supported room action is required." }, { status: 400 });
  }
  if (action !== "create_room_type" && action !== "create_room" &&
      !canManageFrontDesk) {
    return NextResponse.json({ success: false, message: "You do not have permission to operate the front desk." }, { status: 403 });
  }

  let result: MutationResult;
  try {
    result = await withUserContext(auth.userId, async (run): Promise<MutationResult> => {
      if (action === "create_room_type") {
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const rate = body.rate_per_night;
        if (!validText(name, 100) || !validMoney(rate)) {
          return { success: false, status: 400, message: "Enter a room type name and a valid nightly rate greater than zero." };
        }
        await run(
          `INSERT INTO room_types (property_id, name, rate_per_night)
           VALUES ($1, $2, $3)`,
          [propertyId, name, rate],
        );
        return { success: true, message: `${name} room type created.` };
      }

      if (action === "create_room") {
        const roomTypeId = typeof body.room_type_id === "string" ? body.room_type_id : "";
        const number = typeof body.number === "string" ? body.number.trim() : "";
        const floor = typeof body.floor === "string" ? body.floor.trim() : "";
        if (!UUID_PATTERN.test(roomTypeId) || !validText(number, 30) || !validText(floor, 40)) {
          return { success: false, status: 400, message: "Select a room type and enter a room number and floor." };
        }
        const typeResult = await run<{ id: string }>(
          "SELECT id FROM room_types WHERE id = $1 AND property_id = $2",
          [roomTypeId, propertyId],
        );
        if (!typeResult.rows[0]) return { success: false, status: 404, message: "The selected room type was not found in this property." };
        await run(
          `INSERT INTO rooms (property_id, room_type_id, room_number, floor, status, housekeeping_status)
           VALUES ($1, $2, $3, $4, 'available', 'dirty')`,
          [propertyId, roomTypeId, number, floor],
        );
        await run(
          `INSERT INTO room_housekeeping_jobs (property_id, room_id)
           SELECT property_id, id FROM rooms WHERE property_id = $1 AND LOWER(room_number) = LOWER($2)`,
          [propertyId, number],
        );
        return { success: true, message: `Room ${number} created and queued for housekeeping.` };
      }

      if (action === "create_booking") {
        const roomId = typeof body.room_id === "string" ? body.room_id : "";
        const guestName = typeof body.guest_name === "string" ? body.guest_name.trim() : "";
        const guestPhone = typeof body.guest_phone === "string" ? body.guest_phone.trim() : "";
        const guestIdNumber = typeof body.guest_id_number === "string" ? body.guest_id_number.trim() : "";
        const guestCount = body.guest_count;
        const checkInDate = body.check_in_date;
        const checkOutDate = body.check_out_date;
        const mealAddOns = parseMealAddOns(body.meal_add_ons);
        if (!UUID_PATTERN.test(roomId) || !validText(guestName, 255) || !validText(guestPhone, 50) ||
            (guestIdNumber && guestIdNumber.length > 100) ||
            typeof guestCount !== "number" || !Number.isInteger(guestCount) || guestCount < 1 || guestCount > 20 ||
            !validDate(checkInDate) || !validDate(checkOutDate) || mealAddOns === null) {
          return { success: false, status: 400, message: "Booking details are incomplete or invalid." };
        }
        const nights = (Date.parse(`${checkOutDate}T00:00:00.000Z`) - Date.parse(`${checkInDate}T00:00:00.000Z`)) / 86_400_000;
        if (nights < 1 || nights > 365) {
          return { success: false, status: 400, message: "Choose a stay between one and 365 nights." };
        }

        const roomResult = await run<{
          id: string;
          room_number: string;
          status: RoomStatus;
          housekeeping_status: HousekeepingStatus;
          rate_per_night: string;
        }>(
          `SELECT r.id, r.room_number, r.status, r.housekeeping_status, rt.rate_per_night
           FROM rooms r
           JOIN room_types rt ON rt.id = r.room_type_id AND rt.property_id = r.property_id
           WHERE r.id = $1 AND r.property_id = $2
           FOR UPDATE OF r`,
          [roomId, propertyId],
        );
        const room = roomResult.rows[0];
        if (!room) return { success: false, status: 404, message: "Room not found." };
        if (room.status !== "available" || room.housekeeping_status !== "ready") {
          return { success: false, status: 409, message: `Room ${room.room_number} must be vacant and ready before booking.` };
        }
        const bookingIdResult = await run<{ id: string }>(
          `INSERT INTO room_bookings (
             property_id, room_id, guest_name, guest_phone, guest_id_number, guest_count,
             meal_add_ons, check_in_date, check_out_date, status
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::date, $9::date, 'reserved')
           RETURNING id`,
          [propertyId, roomId, guestName, guestPhone, guestIdNumber || null, guestCount, JSON.stringify(mealAddOns), checkInDate, checkOutDate],
        );
        const bookingId = bookingIdResult.rows[0].id;
        const folioResult = await run<{ id: string }>(
          "INSERT INTO room_folios (property_id, booking_id) VALUES ($1, $2) RETURNING id",
          [propertyId, bookingId],
        );
        const folioId = folioResult.rows[0].id;
        const createdAt = new Date().toISOString();
        const roomCharge = Number((Number(room.rate_per_night) * nights).toFixed(2));
        await run(
          `INSERT INTO room_folio_lines (property_id, folio_id, type, description, amount, created_at)
           VALUES ($1, $2, 'room_charge', $3, $4, $5)`,
          [propertyId, folioId, `Room ${room.room_number} x ${nights} night(s)`, roomCharge, createdAt],
        );
        for (const [meal, nightlyRate] of Object.entries(mealAddOns) as [MealAddOn, number][]) {
          const amount = Number((nightlyRate * guestCount * nights).toFixed(2));
          await run(
            `INSERT INTO room_folio_lines (property_id, folio_id, type, description, amount, created_at)
             VALUES ($1, $2, 'service_charge', $3, $4, $5)`,
            [propertyId, folioId, `${meal === "breakfast" ? "Breakfast" : "Lunch"} x ${guestCount} guest(s) x ${nights} night(s)`, amount, createdAt],
          );
        }
        await run(
          "UPDATE rooms SET status = 'reserved', updated_at = NOW() WHERE id = $1 AND property_id = $2",
          [roomId, propertyId],
        );
        return { success: true, message: `Booking created for ${guestName}.` };
      }

      if (action === "check_in" || action === "check_out") {
        const bookingId = typeof body.booking_id === "string" ? body.booking_id : "";
        if (!UUID_PATTERN.test(bookingId)) {
          return { success: false, status: 400, message: "A valid booking_id is required." };
        }
        const bookingResult = await run<{
          id: string;
          room_id: string;
          folio_id: string;
          room_number: string;
          booking_status: Booking["status"];
          room_status: RoomStatus;
          housekeeping_status: HousekeepingStatus;
        }>(
          `SELECT b.id, b.room_id, f.id AS folio_id, r.room_number,
                  b.status AS booking_status, r.status AS room_status, r.housekeeping_status
           FROM room_bookings b
           JOIN rooms r ON r.id = b.room_id AND r.property_id = b.property_id
           JOIN room_folios f ON f.booking_id = b.id AND f.property_id = b.property_id
           WHERE b.id = $1 AND b.property_id = $2
           FOR UPDATE OF b, r`,
          [bookingId, propertyId],
        );
        const booking = bookingResult.rows[0];
        if (!booking) return { success: false, status: 404, message: "Booking not found." };

        if (action === "check_in") {
          if (booking.booking_status !== "reserved") {
            return { success: false, status: 409, message: "Only reserved bookings can be checked in." };
          }
          if (booking.room_status === "maintenance" || booking.room_status === "occupied") {
            return { success: false, status: 409, message: `Room ${booking.room_number} is ${booking.room_status} and cannot be checked into.` };
          }
          if (booking.housekeeping_status !== "ready") {
            return { success: false, status: 409, message: `Room ${booking.room_number} is ${booking.housekeeping_status} and must be ready before check-in.` };
          }
          await run("UPDATE rooms SET status = 'occupied', updated_at = NOW() WHERE id = $1 AND property_id = $2", [booking.room_id, propertyId]);
          await run("UPDATE room_bookings SET status = 'checked_in', actual_check_in = NOW() WHERE id = $1 AND property_id = $2", [bookingId, propertyId]);
          return { success: true, message: `Checked in to room ${booking.room_number}.` };
        }

        if (booking.booking_status !== "checked_in") {
          return { success: false, status: 409, message: "Only checked-in bookings can be checked out." };
        }
        const pendingRoomCharge = await run<{ id: string }>(
          `SELECT id FROM restaurant_room_charge_requests
           WHERE booking_id = $1 AND property_id = $2 AND status = 'pending'
           LIMIT 1`,
          [bookingId, propertyId],
        );
        if (pendingRoomCharge.rows[0]) {
          return { success: false, status: 409, message: "A restaurant bill is awaiting reception approval. Resolve that room-charge request before checking out." };
        }
        const balanceResult = await run<{ balance: string }>(
          `SELECT COALESCE(SUM(CASE WHEN type = 'payment' THEN -amount ELSE amount END), 0) AS balance
           FROM room_folio_lines WHERE folio_id = $1 AND property_id = $2`,
          [booking.folio_id, propertyId],
        );
        const balance = Number(balanceResult.rows[0]?.balance || 0);
        if (balance > 0.009) {
          return { success: false, status: 409, message: `Folio balance of ${balance.toFixed(2)} must be settled before check-out.` };
        }
        await run(
          `UPDATE rooms
           SET status = 'available', housekeeping_status = 'dirty',
               housekeeping_updated_at = NOW(), housekeeping_updated_by = $3, updated_at = NOW()
           WHERE id = $1 AND property_id = $2`,
          [booking.room_id, propertyId, auth.userId],
        );
        await run(
          "UPDATE room_bookings SET status = 'checked_out', actual_check_out = NOW() WHERE id = $1 AND property_id = $2",
          [bookingId, propertyId],
        );
        await run(
          `INSERT INTO room_housekeeping_jobs (property_id, room_id)
           VALUES ($1, $2)
           ON CONFLICT (room_id) WHERE status <> 'completed' DO NOTHING`,
          [propertyId, booking.room_id],
        );
        return { success: true, message: "Guest checked out. Room is vacant and sent to housekeeping." };
      }

      const folioId = typeof body.folio_id === "string" ? body.folio_id : "";
      if (!UUID_PATTERN.test(folioId)) {
        return { success: false, status: 400, message: "A valid folio_id is required." };
      }
      const folioResult = await run<{ id: string }>(
        "SELECT id FROM room_folios WHERE id = $1 AND property_id = $2 FOR UPDATE",
        [folioId, propertyId],
      );
      if (!folioResult.rows[0]) return { success: false, status: 404, message: "Folio not found." };

      if (action === "folio_charge") {
        const description = typeof body.description === "string" ? body.description.trim() : "";
        const amount = body.amount;
        const lineType = body.line_type === undefined ? "service_charge" : body.line_type;
        const reference = body.reference === undefined ? undefined : body.reference;
        if (!validText(description, 255) || !validMoney(amount) ||
            (lineType !== "service_charge" && lineType !== "room_charge") ||
            (reference !== undefined && !validText(reference, 160))) {
          return { success: false, status: 400, message: "Enter a description and a charge amount greater than zero." };
        }
        if (reference) {
          const existingLine = await run<{ type: string; amount: string }>(
            "SELECT type, amount FROM room_folio_lines WHERE folio_id = $1 AND reference = $2",
            [folioId, reference],
          );
          if (existingLine.rows[0]) {
            if (existingLine.rows[0].type === lineType && Number(existingLine.rows[0].amount) === amount) {
              return { success: true, message: "Room charge was already posted to the folio." };
            }
            return { success: false, status: 409, message: "This folio reference is already used by a different charge." };
          }
        }
        await run(
          `INSERT INTO room_folio_lines (property_id, folio_id, type, description, amount, reference)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [propertyId, folioId, lineType, description, amount, reference || null],
        );
        return { success: true, message: "Folio charge added." };
      }

      const tenders = parseTenders(body.tenders);
      if (!tenders) return { success: false, status: 400, message: "Enter valid payment amounts and an M-Pesa reference when applicable." };
      const amount = Number(tenders.reduce((sum, tender) => sum + tender.amount, 0).toFixed(2));
      const reference = tenders.find((tender) => tender.type === "mpesa")?.reference;
      await run(
        `INSERT INTO room_folio_lines (property_id, folio_id, type, description, amount, reference)
         VALUES ($1, $2, 'payment', $3, $4, $5)`,
        [propertyId, folioId, `Payment (${tenders.map((tender) => tender.type).join(", ")})`, amount, reference || null],
      );
      return { success: true, message: `Payment of ${amount.toFixed(2)} recorded.` };
    });
  } catch (error) {
    return errorResponse(error, "POST");
  }

  return resultResponse(result);
}
