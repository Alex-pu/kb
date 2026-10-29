import { NextResponse } from "next/server";
import { assertOutletAccess, getAuthContext, hasPermission } from "@/lib/auth/require-session";
import { databaseReady, withUserContext } from "@/lib/db/postgres";

export const runtime = "nodejs";

interface EtimsMapping {
  item_id: string;
  etims_item_code: string;
  etims_tax_code: string;
  etims_item_class_code: string;
}

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
      !Array.isArray(body.mappings) || body.mappings.length === 0 || body.mappings.length > 500) {
    return NextResponse.json({ success: false, message: "outlet_id and between 1 and 500 item mappings are required." }, { status: 400 });
  }

  const mappings: EtimsMapping[] = [];
  const itemIds = new Set<string>();
  for (const rawMapping of body.mappings) {
    if (!isRecord(rawMapping) || typeof rawMapping.item_id !== "string" ||
        typeof rawMapping.etims_item_code !== "string" ||
        typeof rawMapping.etims_tax_code !== "string" ||
        typeof rawMapping.etims_item_class_code !== "string") {
      return NextResponse.json({ success: false, message: "Every mapping must contain a catalog item ID, DigiTax barcode, class code, and tax type code." }, { status: 400 });
    }
    const mapping = {
      item_id: rawMapping.item_id,
      etims_item_code: rawMapping.etims_item_code.trim(),
      etims_tax_code: rawMapping.etims_tax_code.trim(),
      etims_item_class_code: rawMapping.etims_item_class_code.trim(),
    };
    if (!/^[0-9a-f-]{36}$/i.test(mapping.item_id) ||
        itemIds.has(mapping.item_id) ||
        !mapping.etims_item_code || mapping.etims_item_code.length > 80 ||
        !/^[ABCDE]$/.test(mapping.etims_tax_code) ||
        !mapping.etims_item_class_code || mapping.etims_item_class_code.length > 40) {
      return NextResponse.json({ success: false, message: "One or more DigiTax mappings are invalid or duplicated." }, { status: 400 });
    }
    itemIds.add(mapping.item_id);
    mappings.push(mapping);
  }

  const scope = assertOutletAccess(auth.bundle, body.outlet_id);
  if (!scope) return NextResponse.json({ success: false, message: "You are not assigned to this outlet." }, { status: 403 });
  if (!hasPermission(auth.bundle, scope.propertyId, "catalog:manage")) {
    return NextResponse.json({ success: false, message: "You do not have permission to manage catalog items." }, { status: 403 });
  }

  try {
    const updatedCount = await withUserContext(auth.userId, async (run) => {
      const eligible = await run<{ count: string }>(
        `SELECT COUNT(DISTINCT i.id)::text AS count
         FROM items i
         JOIN item_outlets io ON io.item_id = i.id AND io.outlet_id = $3
         WHERE i.property_id = $1 AND i.id = ANY($2::uuid[])`,
        [scope.propertyId, mappings.map((mapping) => mapping.item_id), body.outlet_id],
      );
      if (Number(eligible.rows[0]?.count) !== mappings.length) return null;

      const result = await run(
        `UPDATE items i SET
           etims_item_code = mapping.etims_item_code,
           etims_tax_code = mapping.etims_tax_code,
           etims_item_class_code = mapping.etims_item_class_code,
           updated_at = NOW()
         FROM jsonb_to_recordset($1::jsonb) AS mapping(
           item_id UUID,
           etims_item_code TEXT,
           etims_tax_code TEXT,
           etims_item_class_code TEXT
         )
         WHERE i.id = mapping.item_id AND i.property_id = $2`,
        [JSON.stringify(mappings), scope.propertyId],
      );
      return result.rowCount ?? 0;
    });

    if (updatedCount === null) {
      return NextResponse.json({ success: false, message: "Some matched catalog items are not available in this outlet; no mappings were changed." }, { status: 404 });
    }
    return NextResponse.json({ success: true, mapped_count: updatedCount, message: `Saved DigiTax mappings for ${updatedCount} catalog item${updatedCount === 1 ? "" : "s"} using exact barcode matches.` });
  } catch (error) {
    console.error("Failed to save bulk DigiTax catalog mappings.", error);
    return NextResponse.json({ success: false, message: "The DigiTax catalog mappings could not be saved." }, { status: 500 });
  }
}
