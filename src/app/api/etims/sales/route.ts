import { NextResponse } from "next/server";
import { assertOutletAccess, getAuthContext, hasPermission } from "@/lib/auth/require-session";
import { databaseReady } from "@/lib/db/postgres";
import { submitDigitaxSale, type DigitaxSale, type DigitaxSaleItem } from "@/lib/etims/digitax";

export const runtime = "nodejs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSale(value: unknown): DigitaxSale | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  const items: DigitaxSaleItem[] = [];
  for (const rawItem of value.items) {
    if (!isRecord(rawItem) ||
        typeof rawItem.id !== "string" ||
        typeof rawItem.quantity !== "number" ||
        typeof rawItem.unit_price !== "number" ||
        typeof rawItem.total_amount !== "number" ||
        typeof rawItem.item_name !== "string" ||
        typeof rawItem.item_class_code !== "string" ||
        typeof rawItem.item_bar_code !== "string" ||
        typeof rawItem.item_tax_type_code !== "string") return null;
    const item: DigitaxSaleItem = {
      id: rawItem.id,
      quantity: rawItem.quantity,
      unit_price: rawItem.unit_price,
      total_amount: rawItem.total_amount,
      item_name: rawItem.item_name,
      item_class_code: rawItem.item_class_code,
      item_bar_code: rawItem.item_bar_code,
      item_tax_type_code: rawItem.item_tax_type_code,
    };
    for (const key of ["taxable_amount", "tax_amount", "package_unit_quantity", "discount_rate", "discount_amount"] as const) {
      const field = rawItem[key];
      if (field !== undefined) {
        if (typeof field !== "number") return null;
        item[key] = field;
      }
    }
    if (rawItem.item_description !== undefined) {
      if (typeof rawItem.item_description !== "string") return null;
      item.item_description = rawItem.item_description;
    }
    if (rawItem.is_stockable !== undefined) {
      if (typeof rawItem.is_stockable !== "boolean") return null;
      item.is_stockable = rawItem.is_stockable;
    }
    items.push(item);
  }
  if (typeof value.sale_date !== "string" ||
      typeof value.trader_invoice_number !== "string" ||
      typeof value.payment_type_code !== "string" ||
      typeof value.invoice_status_code !== "string") return null;
  const sale: DigitaxSale = {
    sale_date: value.sale_date,
    trader_invoice_number: value.trader_invoice_number,
    payment_type_code: value.payment_type_code,
    invoice_status_code: value.invoice_status_code,
    items,
  };
  for (const key of ["customer_tin", "customer_name", "customer_id", "invoice_details"] as const) {
    const field = value[key];
    if (field !== undefined) {
      if (typeof field !== "string") return null;
      sale[key] = field;
    }
  }
  if (value.is_tax_exempt !== undefined) {
    if (typeof value.is_tax_exempt !== "boolean") return null;
    sale.is_tax_exempt = value.is_tax_exempt;
  }
  if (sale.customer_tin) sale.customer_tin = sale.customer_tin.trim().toUpperCase();
  return sale;
}

export async function POST(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, message: "Request body must be valid JSON." }, { status: 400 });
  }
  if (!isRecord(body) || typeof body.outlet_id !== "string" ||
      typeof body.source_reference !== "string" || typeof body.idempotency_key !== "string") {
    return NextResponse.json({ success: false, message: "outlet_id, source_reference, idempotency_key, and sale are required." }, { status: 400 });
  }
  const sale = parseSale(body.sale);
  if (!sale) return NextResponse.json({ success: false, message: "The DigiTax sale payload is incomplete or invalid." }, { status: 400 });
  const scope = assertOutletAccess(auth.bundle, body.outlet_id);
  if (!scope) return NextResponse.json({ success: false, message: "You are not assigned to this outlet." }, { status: 403 });
  if (!hasPermission(auth.bundle, scope.propertyId, "settings:manage") &&
      !hasPermission(auth.bundle, scope.propertyId, "restaurant:settle") &&
      !hasPermission(auth.bundle, scope.propertyId, "accounting:write")) {
    return NextResponse.json({ success: false, message: "You do not have permission to submit eTIMS sales." }, { status: 403 });
  }
  try {
    const result = await submitDigitaxSale(auth.userId, scope.propertyId, {
      outlet_id: body.outlet_id,
      source_reference: body.source_reference,
      idempotency_key: body.idempotency_key,
      sale,
    }, body.retry_blocked === true);
    return NextResponse.json({ success: true, fiscalization: result, message: result.message });
  } catch (error) {
    console.error("Unable to submit DigiTax sale.", error);
    return NextResponse.json({ success: false, message: "The DigiTax sale could not be processed. Verify its status with DigiTax before submitting it again." }, { status: 500 });
  }
}
