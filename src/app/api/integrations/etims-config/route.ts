import { NextResponse } from "next/server";
import { assertOutletAccess, getAuthContext, hasPermission } from "@/lib/auth/require-session";
import { databaseReady, withUserContext } from "@/lib/db/postgres";
import { encryptSecret } from "@/lib/supabase/secret-crypto";

export const runtime = "nodejs";

function validHttpsEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

export async function GET(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });
  const outletId = new URL(request.url).searchParams.get("outlet_id");
  if (!outletId) return NextResponse.json({ success: false, message: "outlet_id is required." }, { status: 400 });
  const scope = assertOutletAccess(auth.bundle, outletId);
  if (!scope) return NextResponse.json({ success: false, message: "You are not assigned to this outlet." }, { status: 403 });
  if (!hasPermission(auth.bundle, scope.propertyId, "settings:manage")) return NextResponse.json({ success: false, message: "You do not have permission to manage integration settings." }, { status: 403 });
  const result = await withUserContext(auth.userId, (run) => run<{
    etims_enabled: boolean; etims_business_name: string | null; etims_endpoint: string | null;
    etims_username: string | null; etims_password_encrypted: string | null;
  }>(
    `SELECT etims_enabled, etims_business_name, etims_endpoint, etims_username, etims_password_encrypted
     FROM property_integration_configs
     WHERE property_id = $1 AND outlet_id = $2`,
    [scope.propertyId, outletId],
  ));
  const config = result.rows[0];
  return NextResponse.json({
    success: true,
    config: config ? {
      enabled: config.etims_enabled,
      business_name: config.etims_business_name ?? "",
      endpoint: config.etims_endpoint ?? "",
      username: config.etims_username ?? "",
      has_password: Boolean(config.etims_password_encrypted),
    } : null,
  });
}

export async function PATCH(request: Request) {
  if (!databaseReady()) return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });
  let body: { outlet_id?: string; enabled?: boolean; business_name?: string; endpoint?: string; username?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, message: "Request body must be valid JSON." }, { status: 400 });
  }
  if (!body.outlet_id || typeof body.enabled !== "boolean" || typeof body.business_name !== "string" ||
      typeof body.endpoint !== "string" || typeof body.username !== "string" ||
      (body.password !== undefined && typeof body.password !== "string")) {
    return NextResponse.json({ success: false, message: "The eTIMS configuration is incomplete or invalid." }, { status: 400 });
  }
  const businessName = body.business_name.trim();
  const endpoint = body.endpoint.trim();
  const username = body.username.trim();
  const password = body.password?.trim() ?? "";
  if (businessName.length > 255 || username.length > 255 || password.length > 2000 ||
      (body.enabled && (!businessName || !username || !endpoint || !validHttpsEndpoint(endpoint)))) {
    return NextResponse.json({ success: false, message: "Enabled eTIMS configuration requires a business name, username, and an HTTPS endpoint without embedded credentials." }, { status: 400 });
  }
  const scope = assertOutletAccess(auth.bundle, body.outlet_id);
  if (!scope) return NextResponse.json({ success: false, message: "You are not assigned to this outlet." }, { status: 403 });
  if (!hasPermission(auth.bundle, scope.propertyId, "settings:manage")) return NextResponse.json({ success: false, message: "You do not have permission to manage integration settings." }, { status: 403 });
  let encryptedPassword: string | null = null;
  if (password) {
    try {
      encryptedPassword = encryptSecret(password);
    } catch (error) {
      console.error("Unable to encrypt eTIMS credentials.", error);
      return NextResponse.json({ success: false, message: "DARAJA_CONFIG_ENCRYPTION_KEY must be configured before saving provider credentials." }, { status: 503 });
    }
  }
  try {
    await withUserContext(auth.userId, (run) => run(
      `INSERT INTO property_integration_configs
         (property_id, outlet_id, etims_enabled, etims_business_name, etims_endpoint, etims_username, etims_password_encrypted, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (property_id, outlet_id) DO UPDATE SET
         etims_enabled = EXCLUDED.etims_enabled,
         etims_business_name = EXCLUDED.etims_business_name,
         etims_endpoint = EXCLUDED.etims_endpoint,
         etims_username = EXCLUDED.etims_username,
         etims_password_encrypted = COALESCE(EXCLUDED.etims_password_encrypted, property_integration_configs.etims_password_encrypted),
         updated_at = NOW()`,
      [scope.propertyId, body.outlet_id, body.enabled, businessName || null, endpoint || null, username || null, encryptedPassword],
    ));
    return NextResponse.json({ success: true, message: "eTIMS configuration saved securely." });
  } catch (error) {
    console.error("Failed to save eTIMS configuration.", error);
    return NextResponse.json({ success: false, message: "The eTIMS configuration could not be saved." }, { status: 500 });
  }
}
