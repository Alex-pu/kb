import { NextResponse } from "next/server";
import { assertOutletAccess, getAuthContext, hasPermission } from "@/lib/auth/require-session";
import { databaseReady } from "@/lib/db/postgres";
import { fiscalizeRestaurantBill } from "@/lib/etims/restaurant-bills";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });
  let body: { outlet_id?: string; check_id?: string; action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, message: "Request body must be valid JSON." }, { status: 400 });
  }
  if (!body.outlet_id || !body.check_id || (body.action !== undefined && body.action !== "retry_blocked")) {
    return NextResponse.json({ success: false, message: "A valid outlet_id and check_id are required." }, { status: 400 });
  }
  const scope = assertOutletAccess(auth.bundle, body.outlet_id);
  if (!scope) return NextResponse.json({ success: false, message: "You are not assigned to this outlet." }, { status: 403 });
  if (!hasPermission(auth.bundle, scope.propertyId, "restaurant:settle")) {
    return NextResponse.json({ success: false, message: "Only restaurant cashiers can manage bill fiscalization." }, { status: 403 });
  }
  try {
    const result = await fiscalizeRestaurantBill(auth.userId, scope.propertyId, body.outlet_id, body.check_id, body.action === "retry_blocked");
    return NextResponse.json({ success: true, fiscalization: result, message: result.message });
  } catch (error) {
    console.error("Unable to process restaurant bill fiscalization.", error);
    return NextResponse.json({ success: false, message: "The paid bill fiscalization could not be processed. Do not submit it manually until its eTIMS status is verified." }, { status: 500 });
  }
}
