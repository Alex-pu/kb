import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { databaseReady, query } from "@/lib/db/postgres";
import { decryptSecret } from "@/lib/supabase/secret-crypto";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!databaseReady()) {
    return NextResponse.json({ ResultCode: 1, ResultDesc: "Payment validation is unavailable." }, { status: 503 });
  }
  const url = new URL(request.url);
  const propertyId = url.searchParams.get("property_id");
  const outletId = url.searchParams.get("outlet_id");
  const suppliedSecret = url.searchParams.get("secret");
  if (!propertyId || !outletId || !suppliedSecret) {
    return NextResponse.json({ ResultCode: 1, ResultDesc: "Invalid validation endpoint." }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null) throw new Error("Invalid C2B validation payload.");
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ResultCode: 1, ResultDesc: "Invalid validation payload." }, { status: 400 });
  }

  const result = await query<{
    callback_secret_encrypted: string;
    short_code: string;
    enabled: boolean;
  }>(
    `SELECT callback_secret_encrypted, short_code, enabled
     FROM daraja_shop_configs WHERE property_id = $1 AND outlet_id = $2`,
    [propertyId, outletId],
  );
  const config = result.rows[0];
  if (!config || !config.enabled) {
    return NextResponse.json({ ResultCode: 1, ResultDesc: "Daraja is not enabled for this outlet." }, { status: 401 });
  }
  let callbackSecret: string;
  try {
    callbackSecret = decryptSecret(config.callback_secret_encrypted);
  } catch (error) {
    console.error("Unable to decrypt Daraja callback secret for C2B validation.", error);
    return NextResponse.json({ ResultCode: 1, ResultDesc: "Payment validation is unavailable." }, { status: 500 });
  }
  const supplied = Buffer.from(suppliedSecret);
  const expected = Buffer.from(callbackSecret);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return NextResponse.json({ ResultCode: 1, ResultDesc: "Invalid validation endpoint." }, { status: 401 });
  }
  if (String(body.BusinessShortCode || "") !== config.short_code ||
      typeof body.BillRefNumber !== "string" ||
      !/^[0-9]{6}$/.test(body.BillRefNumber.trim()) ||
      !Number.isFinite(Number(body.TransAmount)) ||
      Number(body.TransAmount) <= 0) {
    return NextResponse.json({ ResultCode: 1, ResultDesc: "Invalid bill reference or payment amount." });
  }

  const bill = await query<{ total: string }>(
    `SELECT total FROM restaurant_checks
     WHERE property_id = $1 AND outlet_id = $2 AND bill_number = $3 AND status = 'open'`,
    [propertyId, outletId, body.BillRefNumber.trim()],
  );
  if (!bill.rows[0] || Math.abs(Number(bill.rows[0].total) - Number(body.TransAmount)) > 0.009) {
    return NextResponse.json({ ResultCode: 1, ResultDesc: "Bill not found or payment amount does not match." });
  }

  return NextResponse.json({ ResultCode: 0, ResultDesc: "Accepted" });
}
