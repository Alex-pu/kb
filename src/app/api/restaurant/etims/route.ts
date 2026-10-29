import { NextResponse } from "next/server";
import { assertOutletAccess, getAuthContext, hasPermission } from "@/lib/auth/require-session";
import { databaseReady } from "@/lib/db/postgres";
import { submitRestaurantBillToDigitax } from "@/lib/etims/restaurant-digitax";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });
  let body: { outlet_id?: string; check_id?: string; customer_pin?: string; customer_name?: string; action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, message: "Request body must be valid JSON." }, { status: 400 });
  }
  if (!body.outlet_id || !body.check_id ||
      (body.customer_pin !== undefined && typeof body.customer_pin !== "string") ||
      (body.customer_name !== undefined && typeof body.customer_name !== "string") ||
      (body.action !== undefined && body.action !== "retry_blocked")) {
    return NextResponse.json({ success: false, message: "A valid outlet_id and check_id are required." }, { status: 400 });
  }
  const customerPin = body.customer_pin?.trim().toUpperCase() || undefined;
  const customerName = body.customer_name?.trim();
  if (customerPin && !/^[A-Z]\d{9}[A-Z]$/.test(customerPin)) {
    return NextResponse.json({ success: false, message: "Enter a valid KRA PIN such as P123456789Y." }, { status: 400 });
  }
  if (customerName && customerName.length > 255) {
    return NextResponse.json({ success: false, message: "Customer name must not exceed 255 characters." }, { status: 400 });
  }
  const scope = assertOutletAccess(auth.bundle, body.outlet_id);
  if (!scope) return NextResponse.json({ success: false, message: "You are not assigned to this outlet." }, { status: 403 });
  if (!hasPermission(auth.bundle, scope.propertyId, "restaurant:settle")) {
    return NextResponse.json({ success: false, message: "Only restaurant cashiers can manage bill fiscalization." }, { status: 403 });
  }
  try {
    const result = await submitRestaurantBillToDigitax(
      auth.userId,
      scope.propertyId,
      body.outlet_id,
      body.check_id,
      customerPin,
      customerName || undefined,
      body.action === "retry_blocked",
    );
    return NextResponse.json({ success: true, fiscalization: result, message: result.message });
  } catch (error) {
    console.error("Unable to process restaurant bill fiscalization.", error);
    return NextResponse.json({ success: false, message: "The paid bill fiscalization could not be processed. Do not submit it manually until its eTIMS status is verified." }, { status: 500 });
  }
}
