import { NextResponse } from "next/server";
import { databaseReady, localApiAuthorized, query } from "@/lib/db/postgres";

export const runtime = "nodejs";

interface IntegrationConfigBody {
  property_id?: string;
  outlet_id?: string;
  etims_enabled?: boolean;
  etims_business_name?: string;
  etims_pin?: string;
  etims_device_serial?: string;
  etims_endpoint?: string;
  printer_enabled?: boolean;
  printer_model?: string;
  printer_connection?: "network" | "bluetooth" | "usb";
  printer_host?: string;
  printer_port?: number;
  auto_print_receipts?: boolean;
}

export async function POST(request: Request) {
  if (!localApiAuthorized(request)) return NextResponse.json({ success: false, message: "LOCAL_API_TOKEN is required for LAN admin writes." }, { status: 401 });
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });

  let body: IntegrationConfigBody;
  try {
    body = await request.json() as IntegrationConfigBody;
  } catch {
    return NextResponse.json({ success: false, message: "Configuration body must be valid JSON." }, { status: 400 });
  }

  if (!body.property_id) return NextResponse.json({ success: false, message: "property_id is required." }, { status: 400 });

  await query(
    `
      INSERT INTO property_integration_configs (
        property_id, outlet_id, etims_enabled, etims_business_name, etims_pin,
        etims_device_serial, etims_endpoint, printer_enabled, printer_model,
        printer_connection, printer_host, printer_port, auto_print_receipts, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
      ON CONFLICT (property_id, outlet_id)
      DO UPDATE SET
        etims_enabled = EXCLUDED.etims_enabled,
        etims_business_name = EXCLUDED.etims_business_name,
        etims_pin = EXCLUDED.etims_pin,
        etims_device_serial = EXCLUDED.etims_device_serial,
        etims_endpoint = EXCLUDED.etims_endpoint,
        printer_enabled = EXCLUDED.printer_enabled,
        printer_model = EXCLUDED.printer_model,
        printer_connection = EXCLUDED.printer_connection,
        printer_host = EXCLUDED.printer_host,
        printer_port = EXCLUDED.printer_port,
        auto_print_receipts = EXCLUDED.auto_print_receipts,
        updated_at = NOW()
    `,
    [
      body.property_id,
      body.outlet_id || null,
      body.etims_enabled ?? false,
      body.etims_business_name || null,
      body.etims_pin || null,
      body.etims_device_serial || null,
      body.etims_endpoint || null,
      body.printer_enabled ?? false,
      body.printer_model || null,
      body.printer_connection || null,
      body.printer_host || null,
      body.printer_port || null,
      body.auto_print_receipts ?? false,
    ],
  );

  return NextResponse.json({ success: true, message: "eTIMS and printer settings saved to local PostgreSQL." });
}
