import type { QueryResultRow } from "pg";
import { withUserContext } from "@/lib/db/postgres";
import { submitDigitaxSale, type DigitaxResult } from "@/lib/etims/digitax";

interface CheckRow extends QueryResultRow {
  id: string;
  bill_number: string;
  lines: Array<{ item?: { id?: string; name?: string; price?: number }; quantity?: number }>;
  total: string;
  status: string;
  settled_at: string | null;
}

interface MappingRow extends QueryResultRow {
  id: string;
  name: string;
  etims_item_code: string | null;
  etims_item_class_code: string | null;
  etims_tax_code: string | null;
  digitax_sync_status: string;
  digitax_item_type_code: string | null;
}

function saleDate(value: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

function paymentTypeCode(types: string[]): string {
  const unique = [...new Set(types)];
  if (unique.length === 1) {
    return ({ cash: "01", room_charge: "02", card: "05", mpesa: "06" } as Record<string, string>)[unique[0]] ?? "07";
  }
  return unique.includes("cash") && unique.includes("room_charge") ? "03" : "07";
}

export async function submitRestaurantBillToDigitax(
  userId: string,
  propertyId: string,
  outletId: string,
  checkId: string,
  customerTin: string | undefined,
  customerName: string | undefined,
  retryBlocked = false,
): Promise<DigitaxResult> {
  const data = await withUserContext(userId, async (run) => {
    const checkResult = await run<CheckRow>(
      `SELECT id, bill_number, lines, total, status, settled_at
       FROM restaurant_checks
       WHERE id = $1 AND property_id = $2 AND outlet_id = $3`,
      [checkId, propertyId, outletId],
    );
    const check = checkResult.rows[0];
    if (!check || check.status !== "settled" || !check.settled_at) {
      return { kind: "result" as const, result: { status: "blocked" as const, message: "Only a paid restaurant bill can be submitted to DigiTax." } };
    }

    const itemIds = [...new Set((check.lines ?? [])
      .map((line) => line.item?.id)
      .filter((id): id is string => Boolean(id)))];
    const mappingsResult = itemIds.length ? await run<MappingRow>(
      `SELECT id, name, etims_item_code, etims_item_class_code, etims_tax_code,
              digitax_sync_status, digitax_item_type_code
       FROM items WHERE property_id = $1 AND id = ANY($2::uuid[])`,
      [propertyId, itemIds],
    ) : { rows: [] as MappingRow[] };
    const mappings = new Map(mappingsResult.rows.map((item) => [item.id, item]));
    const payments = await run<{ tender_type: string }>(
      `SELECT DISTINCT tender_type FROM restaurant_check_payments
       WHERE property_id = $1 AND check_id = $2`,
      [propertyId, checkId],
    );

    const items = [];
    for (let index = 0; index < check.lines.length; index += 1) {
      const line = check.lines[index];
      const itemId = line.item?.id;
      const mapping = itemId ? mappings.get(itemId) : undefined;
      const quantity = Number(line.quantity);
      const unitPrice = Number(line.item?.price);
      if (!mapping?.etims_item_code || !mapping.etims_item_class_code ||
          !mapping.etims_tax_code || !/^[ABCDE]$/.test(mapping.etims_tax_code)) {
        return {
          kind: "result" as const,
          result: {
            status: "blocked" as const,
            message: `Complete the DigiTax item barcode, item class code, and tax type mapping for ${line.item?.name ?? "every bill item"} in Catalog.`,
          },
        };
      }
      if (mapping.digitax_sync_status !== "synced" ||
          !["2", "3"].includes(mapping.digitax_item_type_code ?? "")) {
        return {
          kind: "result" as const,
          result: {
            status: "blocked" as const,
            message: `${mapping.name} is not registered and fully synchronized with DigiTax. Sync the catalog item before issuing the eTIMS receipt.`,
          },
        };
      }
      if (!Number.isFinite(quantity) || quantity <= 0 ||
          !Number.isFinite(unitPrice) || unitPrice < 0) {
        return { kind: "result" as const, result: { status: "blocked" as const, message: "Bill item details are incomplete; no sale was sent to DigiTax." } };
      }
      const totalAmount = Math.round(unitPrice * quantity * 100) / 100;
      items.push({
        id: `${itemId}-${index + 1}`,
        quantity,
        unit_price: unitPrice,
        total_amount: totalAmount,
        item_name: mapping.name,
        item_class_code: mapping.etims_item_class_code,
        item_bar_code: mapping.etims_item_code,
        item_tax_type_code: mapping.etims_tax_code,
        package_unit_quantity: quantity,
        discount_rate: 0,
        discount_amount: 0,
        item_description: mapping.name,
        is_stockable: mapping.digitax_item_type_code === "2",
      });
    }

    const total = Number(check.total);
    const lineTotal = Math.round(items.reduce((sum, item) => sum + item.total_amount, 0) * 100) / 100;
    if (!items.length || !Number.isFinite(total) || Math.abs(lineTotal - total) > 0.01) {
      return { kind: "result" as const, result: { status: "blocked" as const, message: "Bill line totals do not match the paid bill total; no sale was sent to DigiTax." } };
    }

    return {
      kind: "sale" as const,
      check,
      sale: {
        sale_date: saleDate(check.settled_at),
        trader_invoice_number: check.bill_number,
        payment_type_code: paymentTypeCode(payments.rows.map((payment) => payment.tender_type)),
        invoice_status_code: "01",
        ...(customerTin ? { customer_tin: customerTin.trim().toUpperCase() } : {}),
        ...(customerTin && customerName ? { customer_name: customerName.trim() } : {}),
        items,
      },
    };
  });

  if (data.kind === "result") return data.result;
  return submitDigitaxSale(userId, propertyId, {
    outlet_id: outletId,
    source_reference: data.check.bill_number,
    idempotency_key: `restaurant-check:${checkId}`,
    restaurant_check_id: checkId,
    sale: data.sale,
  }, retryBlocked);
}
