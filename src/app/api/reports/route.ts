import { NextResponse } from "next/server";
import type { QueryResultRow } from "pg";
import { getAuthContext, hasPermission } from "@/lib/auth/require-session";
import { databaseReady, withUserContext } from "@/lib/db/postgres";

export const runtime = "nodejs";

interface DailySalesRow extends QueryResultRow {
  date: string;
  source: "POS" | "Dining";
  transaction_count: string;
  sales: string;
}

interface StaffSalesRow extends QueryResultRow {
  staff_name: string;
  role: "Cashier" | "Waiter";
  source: "POS" | "Dining";
  transaction_count: string;
  sales: string;
}

interface ProductSalesRow extends QueryResultRow {
  item_name: string;
  category: string;
  quantity: string;
  sales: string;
}

interface PaymentSalesRow extends QueryResultRow {
  tender_type: string;
  transaction_count: string;
  amount: string;
}

interface ShiftReportRow extends QueryResultRow {
  id: string;
  business_date: string;
  outlet_name: string;
  cashier_name: string;
  shift_area: string;
  shift_period: string | null;
  status: "open" | "closed";
  opening_float: string;
  cash_sales: string;
  counted_cash: string | null;
  variance: string | null;
}

interface FinancialRow extends QueryResultRow {
  account_id: string;
  code: string;
  account_name: string;
  account_type: "asset" | "liability" | "equity" | "revenue" | "expense";
  period_debit: string;
  period_credit: string;
  year_debit: string;
  year_credit: string;
  balance_debit: string;
  balance_credit: string;
}

interface ComparisonRow extends QueryResultRow {
  transactions: string;
  sales: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value: string) {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function number(value: string | null) {
  return value == null ? null : Number(value);
}

export async function GET(request: Request) {
  if (!databaseReady()) {
    return NextResponse.json({ success: false, message: "DATABASE_URL is not configured." }, { status: 503 });
  }
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ success: false, message: "Not signed in." }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const propertyId = params.get("property_id") ?? "";
  const outletId = params.get("outlet_id") || null;
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";

  if (!propertyId || !isValidDate(from) || !isValidDate(to) || from > to) {
    return NextResponse.json({ success: false, message: "A property and valid date range are required." }, { status: 400 });
  }

  const property = auth.bundle.properties.find((candidate) => candidate.id === propertyId);
  if (!property || !hasPermission(auth.bundle, propertyId, "analytics:read")) {
    return NextResponse.json({ success: false, message: "You do not have permission to view reports for this property." }, { status: 403 });
  }
  if (outletId && !auth.bundle.outlets.some((outlet) => outlet.id === outletId && outlet.property_id === propertyId)) {
    return NextResponse.json({ success: false, message: "The selected outlet is not assigned to this property." }, { status: 403 });
  }

  const canViewFinancials = hasPermission(auth.bundle, propertyId, "accounting:read");
  const rangeLength = (
    Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)
  ) / 86_400_000 + 1;
  if (rangeLength > 3_660) {
    return NextResponse.json({ success: false, message: "Report date ranges cannot exceed ten years." }, { status: 400 });
  }
  const previousTo = new Date(Date.parse(`${from}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
  const previousFrom = new Date(Date.parse(`${previousTo}T00:00:00.000Z`) - (rangeLength - 1) * 86_400_000)
    .toISOString().slice(0, 10);

  try {
    const report = await withUserContext(auth.userId, async (run) => {
      const filters = [propertyId, outletId, from, to] as const;
      const [daily, staff, products, payments, shifts, financial, comparison] = await Promise.all([
        run<DailySalesRow>(
          `WITH sales AS (
             SELECT COALESCE(s.business_date, o.created_at::date)::text AS date,
                    'POS'::text AS source, o.id, o.total AS sales
             FROM orders o
             JOIN shifts s ON s.id = o.shift_id
             WHERE o.property_id = $1 AND ($2::uuid IS NULL OR o.outlet_id = $2)
               AND o.status = 'posted'
               AND COALESCE(s.business_date, o.created_at::date) BETWEEN $3::date AND $4::date
             UNION ALL
             SELECT COALESCE(s.business_date, rc.settled_at::date)::text,
                    'Dining'::text, rc.id, rc.total
             FROM restaurant_checks rc
             JOIN shifts s ON s.id = rc.shift_id
             WHERE rc.property_id = $1 AND ($2::uuid IS NULL OR rc.outlet_id = $2)
               AND rc.status = 'settled'
               AND COALESCE(s.business_date, rc.settled_at::date) BETWEEN $3::date AND $4::date
           )
           SELECT date, source, COUNT(*)::text AS transaction_count,
                  COALESCE(SUM(sales), 0)::text AS sales
           FROM sales GROUP BY date, source ORDER BY date DESC, source`,
          [...filters],
        ),
        run<StaffSalesRow>(
          `WITH sales AS (
             SELECT cashier.full_name AS staff_name, 'Cashier'::text AS role,
                    'POS'::text AS source, o.id, o.total AS sales
             FROM orders o
             JOIN shifts s ON s.id = o.shift_id
             JOIN users cashier ON cashier.id = o.cashier_id
             WHERE o.property_id = $1 AND ($2::uuid IS NULL OR o.outlet_id = $2)
               AND o.status = 'posted'
               AND COALESCE(s.business_date, o.created_at::date) BETWEEN $3::date AND $4::date
             UNION ALL
             SELECT waiter.full_name, 'Waiter'::text, 'Dining'::text, rc.id, rc.total
             FROM restaurant_checks rc
             JOIN shifts s ON s.id = rc.shift_id
             JOIN users waiter ON waiter.id = rc.waiter_id
             WHERE rc.property_id = $1 AND ($2::uuid IS NULL OR rc.outlet_id = $2)
               AND rc.status = 'settled'
               AND COALESCE(s.business_date, rc.settled_at::date) BETWEEN $3::date AND $4::date
           )
           SELECT staff_name, role, source, COUNT(*)::text AS transaction_count,
                  COALESCE(SUM(sales), 0)::text AS sales
           FROM sales GROUP BY staff_name, role, source ORDER BY SUM(sales) DESC, staff_name`,
          [...filters],
        ),
        run<ProductSalesRow>(
          `WITH sold_lines AS (
             SELECT i.name AS item_name, COALESCE(c.name, 'Uncategorized') AS category,
                    ol.quantity, ol.line_total AS sales
             FROM order_lines ol
             JOIN orders o ON o.id = ol.order_id AND o.property_id = ol.property_id
             JOIN shifts s ON s.id = o.shift_id
             JOIN items i ON i.id = ol.item_id AND i.property_id = ol.property_id
             LEFT JOIN categories c ON c.id = i.category_id
             WHERE o.property_id = $1 AND ($2::uuid IS NULL OR o.outlet_id = $2)
               AND o.status = 'posted'
               AND COALESCE(s.business_date, o.created_at::date) BETWEEN $3::date AND $4::date
             UNION ALL
             SELECT line.value->'item'->>'name',
                    COALESCE(NULLIF(line.value->'item'->>'category', ''), 'Uncategorized'),
                    (line.value->>'quantity')::numeric,
                    (line.value->'item'->>'price')::numeric * (line.value->>'quantity')::numeric
             FROM restaurant_checks rc
             JOIN shifts s ON s.id = rc.shift_id
             CROSS JOIN LATERAL jsonb_array_elements(rc.lines) AS line(value)
             WHERE rc.property_id = $1 AND ($2::uuid IS NULL OR rc.outlet_id = $2)
               AND rc.status = 'settled'
               AND COALESCE(s.business_date, rc.settled_at::date) BETWEEN $3::date AND $4::date
           )
           SELECT item_name, category, SUM(quantity)::text AS quantity,
                  SUM(sales)::text AS sales
           FROM sold_lines GROUP BY item_name, category ORDER BY SUM(sales) DESC, item_name
           LIMIT 200`,
          [...filters],
        ),
        run<PaymentSalesRow>(
          `WITH tender_sales AS (
             SELECT p.tender_type, p.amount, p.order_id AS transaction_id
             FROM payments p
             JOIN orders o ON o.id = p.order_id AND o.property_id = p.property_id
             JOIN shifts s ON s.id = o.shift_id
             WHERE p.property_id = $1 AND ($2::uuid IS NULL OR o.outlet_id = $2)
               AND o.status = 'posted'
               AND COALESCE(s.business_date, o.created_at::date) BETWEEN $3::date AND $4::date
             UNION ALL
             SELECT p.tender_type, p.amount, p.check_id
             FROM restaurant_check_payments p
             JOIN restaurant_checks rc ON rc.id = p.check_id AND rc.property_id = p.property_id
             JOIN shifts s ON s.id = rc.shift_id
             WHERE p.property_id = $1 AND ($2::uuid IS NULL OR rc.outlet_id = $2)
               AND rc.status = 'settled'
               AND COALESCE(s.business_date, rc.settled_at::date) BETWEEN $3::date AND $4::date
           )
           SELECT tender_type, COUNT(DISTINCT transaction_id)::text AS transaction_count,
                  SUM(amount)::text AS amount
           FROM tender_sales GROUP BY tender_type ORDER BY SUM(amount) DESC`,
          [...filters],
        ),
        run<ShiftReportRow>(
          `SELECT s.id, COALESCE(s.business_date, s.opened_at::date)::text AS business_date,
                  o.name AS outlet_name, cashier.full_name AS cashier_name,
                  COALESCE(s.shift_area, 'pos') AS shift_area, s.shift_period, s.status,
                  s.opening_float::text, s.cash_sales::text, s.counted_cash::text, s.variance::text
           FROM shifts s
           JOIN outlets o ON o.id = s.outlet_id AND o.property_id = s.property_id
           JOIN users cashier ON cashier.id = s.cashier_id
           WHERE s.property_id = $1 AND ($2::uuid IS NULL OR s.outlet_id = $2)
             AND COALESCE(s.business_date, s.opened_at::date) BETWEEN $3::date AND $4::date
             AND COALESCE(s.shift_area, 'pos') = 'pos'
           ORDER BY COALESCE(s.business_date, s.opened_at::date) DESC, s.opened_at DESC
           LIMIT 500`,
          [...filters],
        ),
        canViewFinancials
          ? run<FinancialRow>(
              `SELECT coa.id AS account_id, coa.code, coa.name AS account_name,
                      coa.account_type,
                      COALESCE(SUM(jl.debit) FILTER (
                        WHERE je.entry_date BETWEEN $2::date AND $3::date
                      ), 0)::text AS period_debit,
                      COALESCE(SUM(jl.credit) FILTER (
                        WHERE je.entry_date BETWEEN $2::date AND $3::date
                      ), 0)::text AS period_credit,
                      COALESCE(SUM(jl.debit) FILTER (
                        WHERE je.entry_date >= date_trunc('year', $3::date)::date
                      ), 0)::text AS year_debit,
                      COALESCE(SUM(jl.credit) FILTER (
                        WHERE je.entry_date >= date_trunc('year', $3::date)::date
                      ), 0)::text AS year_credit,
                      COALESCE(SUM(jl.debit), 0)::text AS balance_debit,
                      COALESCE(SUM(jl.credit), 0)::text AS balance_credit
               FROM chart_of_accounts coa
               LEFT JOIN journal_entries je ON je.property_id = coa.property_id
                 AND je.entry_date <= $3::date
               LEFT JOIN journal_lines jl ON jl.journal_entry_id = je.id
                 AND jl.account_id = coa.id AND jl.property_id = coa.property_id
               WHERE coa.property_id = $1
               GROUP BY coa.id, coa.code, coa.name, coa.account_type
               ORDER BY coa.code`,
              [propertyId, from, to],
            )
          : Promise.resolve({ rows: [] as FinancialRow[] }),
        run<ComparisonRow>(
          `WITH sales AS (
             SELECT o.id, o.total AS sales
             FROM orders o
             JOIN shifts s ON s.id = o.shift_id
             WHERE o.property_id = $1 AND ($2::uuid IS NULL OR o.outlet_id = $2)
               AND o.status = 'posted'
               AND COALESCE(s.business_date, o.created_at::date) BETWEEN $3::date AND $4::date
             UNION ALL
             SELECT rc.id, rc.total
             FROM restaurant_checks rc
             JOIN shifts s ON s.id = rc.shift_id
             WHERE rc.property_id = $1 AND ($2::uuid IS NULL OR rc.outlet_id = $2)
               AND rc.status = 'settled'
               AND COALESCE(s.business_date, rc.settled_at::date) BETWEEN $3::date AND $4::date
           )
           SELECT COUNT(*)::text AS transactions, COALESCE(SUM(sales), 0)::text AS sales
           FROM sales`,
          [propertyId, outletId, previousFrom, previousTo],
        ),
      ]);

      return {
        dailySales: daily.rows.map((row) => ({
          date: row.date,
          source: row.source,
          transactions: Number(row.transaction_count),
          sales: Number(row.sales),
        })),
        staffSales: staff.rows.map((row) => ({
          staffName: row.staff_name,
          role: row.role,
          source: row.source,
          transactions: Number(row.transaction_count),
          sales: Number(row.sales),
        })),
        productSales: products.rows.map((row) => ({
          itemName: row.item_name,
          category: row.category,
          quantity: Number(row.quantity),
          sales: Number(row.sales),
        })),
        paymentSales: payments.rows.map((row) => ({
          tenderType: row.tender_type,
          transactions: Number(row.transaction_count),
          amount: Number(row.amount),
        })),
        shifts: shifts.rows.map((row) => ({
          id: row.id,
          businessDate: row.business_date,
          outletName: row.outlet_name,
          cashierName: row.cashier_name,
          shiftArea: row.shift_area,
          shiftPeriod: row.shift_period,
          status: row.status,
          openingFloat: Number(row.opening_float),
          cashSales: Number(row.cash_sales),
          expectedCash: Number(row.opening_float) + Number(row.cash_sales),
          countedCash: number(row.counted_cash),
          variance: number(row.variance),
        })),
        financial: canViewFinancials
          ? financial.rows.map((row) => ({
              accountId: row.account_id,
              code: row.code,
              name: row.account_name,
              type: row.account_type,
              periodDebit: Number(row.period_debit),
              periodCredit: Number(row.period_credit),
              yearDebit: Number(row.year_debit),
              yearCredit: Number(row.year_credit),
              balanceDebit: Number(row.balance_debit),
              balanceCredit: Number(row.balance_credit),
            }))
          : null,
        previousPeriod: {
          transactions: Number(comparison.rows[0]?.transactions ?? 0),
          sales: Number(comparison.rows[0]?.sales ?? 0),
        },
      };
    });

    return NextResponse.json({ success: true, ...report });
  } catch (error) {
    console.error("Failed to generate reports.", error);
    return NextResponse.json({ success: false, message: "Reports could not be generated." }, { status: 500 });
  }
}
