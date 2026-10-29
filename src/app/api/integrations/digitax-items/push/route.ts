import { NextResponse } from "next/server";
import { assertOutletAccess, getAuthContext, hasPermission } from "@/lib/auth/require-session";
import { databaseReady, withUserContext } from "@/lib/db/postgres";
import { syncCatalogItemToDigitax } from "@/lib/etims/digitax-catalog";

export const runtime = "nodejs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      (body.item_id !== undefined && (typeof body.item_id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.item_id)))) {
    return NextResponse.json({ success: false, message: "outlet_id and an optional item_id are required." }, { status: 400 });
  }
  const scope = assertOutletAccess(auth.bundle, body.outlet_id);
  if (!scope) return NextResponse.json({ success: false, message: "You are not assigned to this outlet." }, { status: 403 });
  if (!hasPermission(auth.bundle, scope.propertyId, "catalog:manage")) {
    return NextResponse.json({ success: false, message: "You do not have permission to manage catalog items." }, { status: 403 });
  }

  try {
    const selection = await withUserContext(auth.userId, async (run) => {
      if (body.item_id) {
        const selected = await run<{ id: string; name: string; has_profile: boolean }>(
          `SELECT i.id, i.name, i.digitax_item_type_code IS NOT NULL AS has_profile
           FROM items i
           WHERE i.id = $1 AND i.property_id = $2
             AND EXISTS (SELECT 1 FROM item_outlets io WHERE io.item_id = i.id AND io.outlet_id = $3)`,
          [body.item_id, scope.propertyId, body.outlet_id],
        );
        return {
          items: selected.rows.filter((row) => row.has_profile).map(({ id, name }) => ({ id, name })),
          missingProfile: selected.rows.some((row) => !row.has_profile) ? 1 : 0,
          notFound: selected.rows.length === 0,
        };
      }
      const selected = await run<{ id: string; name: string }>(
        `SELECT i.id, i.name FROM items i
         WHERE i.property_id = $1 AND i.item_type IN ('retail', 'menu')
           AND EXISTS (SELECT 1 FROM item_outlets io WHERE io.item_id = i.id AND io.outlet_id = $2)
           AND i.digitax_sync_status <> 'synced'
           AND i.digitax_item_type_code IN ('2', '3')
         ORDER BY i.name LIMIT 100`,
        [scope.propertyId, body.outlet_id],
      );
      const missing = await run<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM items i
         WHERE i.property_id = $1 AND i.item_type IN ('retail', 'menu')
           AND i.digitax_item_type_code IS NULL
           AND EXISTS (SELECT 1 FROM item_outlets io WHERE io.item_id = i.id AND io.outlet_id = $2)`,
        [scope.propertyId, body.outlet_id],
      );
      return { items: selected.rows, missingProfile: Number(missing.rows[0]?.count ?? 0), notFound: false };
    });
    if (selection.notFound) return NextResponse.json({ success: false, message: "Catalog item was not found in this outlet." }, { status: 404 });
    if (body.item_id && selection.missingProfile) {
      return NextResponse.json({ success: false, message: "This item has no DigiTax classification profile. Recreate it using an active, completed DigiTax product or service profile." }, { status: 400 });
    }

    const results = [];
    for (const item of selection.items) {
      results.push({
        item_id: item.id,
        item_name: item.name,
        ...await syncCatalogItemToDigitax(auth.userId, scope.propertyId, body.outlet_id, item.id, true),
      });
    }
    const synced = results.filter((result) => result.status === "synced").length;
    const pending = results.filter((result) => result.status === "pending").length;
    const failed = results.filter((result) => result.status === "failed").length;
    const warnings = selection.missingProfile
      ? ` ${selection.missingProfile} existing item(s) need a DigiTax profile before they can be registered.`
      : "";
    return NextResponse.json({
      success: true,
      results,
      counts: { synced, pending, failed, missing_profile: selection.missingProfile },
      message: `DigiTax registration: ${synced} synchronized, ${pending} pending, ${failed} failed.${warnings}`,
    });
  } catch (error) {
    console.error("Unable to push catalog items to DigiTax.", error);
    return NextResponse.json({ success: false, message: "Could not start catalog registration with DigiTax." }, { status: 500 });
  }
}
