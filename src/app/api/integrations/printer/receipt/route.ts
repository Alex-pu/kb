import { NextResponse } from "next/server";
import { localApiAuthorized } from "@/lib/db/postgres";
import { buildEscPosReceipt, ReceiptPrintInput } from "@/lib/integrations/escpos";

export const runtime = "nodejs";

interface PrintRequest extends ReceiptPrintInput {
  property_id?: string;
}

export async function POST(request: Request) {
  if (!localApiAuthorized(request)) return NextResponse.json({ success: false, message: "LOCAL_API_TOKEN is required for printer access." }, { status: 401 });

  let body: PrintRequest;
  try {
    body = await request.json() as PrintRequest;
  } catch {
    return NextResponse.json({ success: false, message: "Receipt body must be valid JSON." }, { status: 400 });
  }
  if (!body.property_id || !body.propertyName || !body.receiptNumber || !Array.isArray(body.lines) || typeof body.total !== "number") {
    return NextResponse.json({ success: false, message: "property_id, receipt details, lines, and total are required." }, { status: 400 });
  }

  const commands = buildEscPosReceipt(body);
  return NextResponse.json({ success: true, format: "escpos", encoding: "base64", payload: Buffer.from(commands).toString("base64") });
}
