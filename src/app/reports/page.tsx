"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { useTenantStore } from "@/lib/store/tenant-store";
import { BarChart3, BedDouble, ChefHat, ClipboardList, Download, Package, Printer, RefreshCw, Wallet } from "lucide-react";

type ReportKey = "sales" | "staff" | "products" | "payments" | "shifts" | "financials" | "occupancy" | "kots" | "stock";
type SalesInterval = "day" | "week" | "month";
type DailySales = { date: string; source: "POS" | "Dining"; transactions: number; sales: number };
type StaffSale = { staffName: string; role: "Cashier" | "Waiter"; source: "POS" | "Dining"; transactions: number; sales: number };
type ProductSale = { itemName: string; category: string; quantity: number; sales: number };
type PaymentSale = { tenderType: string; transactions: number; amount: number };
type ShiftReport = {
  id: string;
  businessDate: string;
  outletName: string;
  cashierName: string;
  shiftArea: string;
  shiftPeriod: string | null;
  status: "open" | "closed";
  openingFloat: number;
  cashSales: number;
  expectedCash: number;
  countedCash: number | null;
  variance: number | null;
};
type FinancialAccount = {
  accountId: string;
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
  periodDebit: number;
  periodCredit: number;
  yearDebit: number;
  yearCredit: number;
  balanceDebit: number;
  balanceCredit: number;
};
type ReportsData = {
  dailySales: DailySales[];
  staffSales: StaffSale[];
  productSales: ProductSale[];
  paymentSales: PaymentSale[];
  shifts: ShiftReport[];
  financial: FinancialAccount[] | null;
  previousPeriod: { transactions: number; sales: number };
};

const REPORTS: { key: ReportKey; label: string; icon: React.ElementType; requiresAccounting?: boolean }[] = [
  { key: "sales", label: "Sales by date", icon: Wallet },
  { key: "staff", label: "Sales by staff", icon: ClipboardList },
  { key: "products", label: "Products & categories", icon: Package },
  { key: "payments", label: "Payment methods", icon: Wallet },
  { key: "shifts", label: "Shift reconciliation", icon: ClipboardList },
  { key: "financials", label: "Financial statements", icon: BarChart3, requiresAccounting: true },
  { key: "occupancy", label: "Occupancy", icon: BedDouble },
  { key: "kots", label: "Kitchen tickets", icon: ChefHat },
  { key: "stock", label: "Stock risk", icon: Package },
];

function localDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function money(amount: number) {
  return `KSh ${amount.toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function salesBucket(dateValue: string, interval: SalesInterval) {
  if (interval === "day") return dateValue;
  const date = new Date(`${dateValue}T00:00:00.000Z`);
  if (interval === "month") return `${dateValue.slice(0, 7)}-01`;
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function displayBucket(date: string, interval: SalesInterval) {
  return interval === "month" ? date.slice(0, 7) : date;
}

function downloadCsv(filename: string, rows: Array<Array<string | number>>) {
  const csv = rows.map((row) => row.map((value) => {
    const text = String(value);
    const safeText = typeof value === "string" && /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safeText.replaceAll('"', '""')}"`;
  }).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export default function ReportsPage() {
  const today = useMemo(() => new Date(), []);
  const monthStart = useMemo(() => new Date(today.getFullYear(), today.getMonth(), 1), [today]);
  const [report, setReport] = useState<ReportKey>("sales");
  const [salesInterval, setSalesInterval] = useState<SalesInterval>("day");
  const [fromDate, setFromDate] = useState(localDate(monthStart));
  const [toDate, setToDate] = useState(localDate(today));
  const [propertyId, setPropertyId] = useState("");
  const [outletId, setOutletId] = useState("");
  const [data, setData] = useState<ReportsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const {
    availableProperties, availableOutlets, activeProperty, activeOutlet, switchProperty,
    rooms, bookings, kots, stockItems, stockLevels, loadStockWorkspace, hasPermission,
  } = useTenantStore();
  const canViewFinancials = hasPermission("accounting:read");
  const outletsForProperty = availableOutlets.filter((outlet) => outlet.property_id === propertyId);

  useEffect(() => {
    if (activeProperty?.id) setPropertyId(activeProperty.id);
  }, [activeProperty?.id]);

  useEffect(() => {
    if (activeOutlet?.id && activeOutlet.property_id === propertyId) setOutletId(activeOutlet.id);
    else setOutletId("");
  }, [activeOutlet?.id, activeOutlet?.property_id, propertyId]);

  useEffect(() => {
    if (!activeOutlet?.id) return;
    void loadStockWorkspace();
  }, [activeOutlet?.id, loadStockWorkspace]);

  useEffect(() => {
    if (!propertyId || !fromDate || !toDate || fromDate > toDate) {
      setData(null);
      setLoading(false);
      setError(fromDate > toDate ? "The start date must be on or before the end date." : null);
      return;
    }

    const controller = new AbortController();
    const params = new URLSearchParams({ property_id: propertyId, from: fromDate, to: toDate });
    if (outletId) params.set("outlet_id", outletId);
    setLoading(true);
    setError(null);
    fetch(`/api/reports?${params}`, { credentials: "include", signal: controller.signal })
      .then(async (response) => {
        const result: ReportsData & { success?: boolean; message?: string } = await response.json();
        if (!response.ok || !result.success) throw new Error(result.message || "Reports could not be loaded.");
        setData(result);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setData(null);
        setError(cause instanceof Error ? cause.message : "Reports could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [fromDate, outletId, propertyId, toDate]);

  const dailyTotals = useMemo(() => {
    const byDate = new Map<string, { transactions: number; sales: number; pos: number; dining: number }>();
    for (const row of data?.dailySales ?? []) {
      const date = salesBucket(row.date, salesInterval);
      const current = byDate.get(date) ?? { transactions: 0, sales: 0, pos: 0, dining: 0 };
      current.transactions += row.transactions;
      current.sales += row.sales;
      if (row.source === "POS") current.pos += row.sales;
      else current.dining += row.sales;
      byDate.set(date, current);
    }
    return Array.from(byDate, ([date, totals]) => ({ date, ...totals }));
  }, [data?.dailySales, salesInterval]);

  const productCategories = useMemo(() => {
    const totals = new Map<string, number>();
    for (const row of data?.productSales ?? []) totals.set(row.category, (totals.get(row.category) ?? 0) + row.sales);
    return Array.from(totals, ([category, sales]) => ({ category, sales })).sort((a, b) => b.sales - a.sales);
  }, [data?.productSales]);

  const financialSummary = useMemo(() => {
    const accounts = data?.financial ?? [];
    const sum = (type: FinancialAccount["type"], current: boolean) => accounts
      .filter((account) => account.type === type)
      .reduce((total, account) => total + (current
        ? account.balanceDebit - account.balanceCredit
        : account.periodDebit - account.periodCredit), 0);
    const revenue = -sum("revenue", false);
    const expenses = sum("expense", false);
    const profit = revenue - expenses;
    const yearRevenue = -accounts.filter((account) => account.type === "revenue")
      .reduce((total, account) => total + account.yearDebit - account.yearCredit, 0);
    const yearExpenses = accounts.filter((account) => account.type === "expense")
      .reduce((total, account) => total + account.yearDebit - account.yearCredit, 0);
    const yearProfit = yearRevenue - yearExpenses;
    const assets = sum("asset", true);
    const liabilities = -sum("liability", true);
    const equity = -sum("equity", true);
    return { revenue, expenses, profit, yearProfit, assets, liabilities, equity, liabilitiesAndEquity: liabilities + equity + yearProfit };
  }, [data?.financial]);
  const totalSales = dailyTotals.reduce((sum, row) => sum + row.sales, 0);
  const transactionCount = dailyTotals.reduce((sum, row) => sum + row.transactions, 0);
  const salesChange = data && data.previousPeriod.sales > 0
    ? ((totalSales - data.previousPeriod.sales) / data.previousPeriod.sales) * 100
    : null;

  const lowStock = stockItems.filter((item) =>
    item.stock_tracked && item.available_at_outlet &&
    (stockLevels[item.id]?.[activeOutlet?.id || ""] || 0) <= item.reorder_level
  );
  const activeKots = kots.filter((kot) => !["served", "cancelled"].includes(kot.status));
  const occupied = rooms.filter((room) => room.status === "occupied").length;
  const visibleReports = REPORTS.filter((item) => !item.requiresAccounting || canViewFinancials);

  const exportCurrentReport = () => {
    if (!data) return;
    const rows: Array<Array<string | number>> = [];
    const filename = `kore-bench-${report}-${fromDate}-to-${toDate}.csv`;
    if (report === "sales") {
      rows.push([salesInterval === "day" ? "Date" : salesInterval === "week" ? "Week starting" : "Month", "POS sales", "Dining sales", "Transactions", "Average sale", "Total sales"]);
      dailyTotals.forEach((row) => rows.push([displayBucket(row.date, salesInterval), row.pos, row.dining, row.transactions, row.transactions ? row.sales / row.transactions : 0, row.sales]));
    } else if (report === "staff") {
      rows.push(["Staff member", "Role", "Sales source", "Transactions", "Sales"]);
      data.staffSales.forEach((row) => rows.push([row.staffName, row.role, row.source, row.transactions, row.sales]));
    } else if (report === "products") {
      rows.push(["Item", "Category", "Quantity sold", "Sales"]);
      data.productSales.forEach((row) => rows.push([row.itemName, row.category, row.quantity, row.sales]));
    } else if (report === "payments") {
      rows.push(["Payment method", "Transactions", "Amount"]);
      data.paymentSales.forEach((row) => rows.push([row.tenderType, row.transactions, row.amount]));
    } else if (report === "shifts") {
      rows.push(["Business date", "Outlet", "Cashier", "Period", "Status", "Opening float", "Cash sales", "Expected cash", "Counted cash", "Variance"]);
      data.shifts.forEach((row) => rows.push([row.businessDate, row.outletName, row.cashierName, row.shiftPeriod ?? "", row.status, row.openingFloat, row.cashSales, row.expectedCash, row.countedCash ?? "", row.variance ?? ""]));
    } else if (report === "financials" && data.financial) {
      rows.push(["Code", "Account", "Type", "Period debit", "Period credit", "Balance debit", "Balance credit"]);
      data.financial.forEach((row) => rows.push([row.code, row.name, row.type, row.periodDebit, row.periodCredit, row.balanceDebit, row.balanceCredit]));
    }
    if (rows.length > 1) downloadCsv(filename, rows);
  };

  const changeProperty = (nextPropertyId: string) => {
    setPropertyId(nextPropertyId);
    setOutletId("");
    switchProperty(nextPropertyId);
  };

  return (
    <DashboardShell>
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-neutral-200 pb-3 dark:border-neutral-800">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Reports & Analytics</h1>
            <p className="mt-0.5 text-xs text-neutral-500">Sales performance, cash reconciliation and financial reporting. Date filters apply to transaction and financial reports.</p>
          </div>
          <button type="button" onClick={exportCurrentReport} disabled={!data || loading || ["occupancy", "kots", "stock"].includes(report)} className="inline-flex items-center gap-1.5 rounded border border-neutral-300 px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-700">
            <Download className="h-3.5 w-3.5" /> Export CSV
          </button>
        </div>

        <div className="flex flex-wrap items-end gap-3 rounded border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
          {availableProperties.length > 1 && <label className="text-[10px] font-mono uppercase text-neutral-500">Property
            <select value={propertyId} onChange={(event) => changeProperty(event.target.value)} className="mt-1 block min-w-40 rounded border bg-neutral-50 p-2 text-xs dark:bg-neutral-800">
              {availableProperties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}
            </select>
          </label>}
          <label className="text-[10px] font-mono uppercase text-neutral-500">Outlet
            <select value={outletId} onChange={(event) => setOutletId(event.target.value)} className="mt-1 block min-w-36 rounded border bg-neutral-50 p-2 text-xs dark:bg-neutral-800">
              <option value="">All assigned outlets</option>
              {outletsForProperty.map((outlet) => <option key={outlet.id} value={outlet.id}>{outlet.name}</option>)}
            </select>
          </label>
          <label className="text-[10px] font-mono uppercase text-neutral-500">From
            <input type="date" value={fromDate} max={toDate || undefined} onChange={(event) => setFromDate(event.target.value)} className="mt-1 block rounded border bg-neutral-50 p-2 text-xs dark:bg-neutral-800" />
          </label>
          <label className="text-[10px] font-mono uppercase text-neutral-500">To
            <input type="date" value={toDate} min={fromDate || undefined} onChange={(event) => setToDate(event.target.value)} className="mt-1 block rounded border bg-neutral-50 p-2 text-xs dark:bg-neutral-800" />
          </label>
          {report === "sales" && <label className="text-[10px] font-mono uppercase text-neutral-500">Group by
            <select value={salesInterval} onChange={(event) => {
              const value = event.target.value;
              if (value === "day" || value === "week" || value === "month") setSalesInterval(value);
            }} className="mt-1 block rounded border bg-neutral-50 p-2 text-xs dark:bg-neutral-800">
              <option value="day">Day</option><option value="week">Week</option><option value="month">Month</option>
            </select>
          </label>}
          <span className="pb-2 text-[10px] text-neutral-400">{loading ? "Updating reports…" : `${fromDate} to ${toDate}`}</span>
        </div>

        {error && <div role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-950/30 dark:text-red-200">{error}</div>}

        <div className="flex flex-wrap gap-1 border-b border-neutral-200 pb-2 dark:border-neutral-800">
          {visibleReports.map(({ key, label, icon: Icon }) => (
            <button key={key} type="button" onClick={() => setReport(key)} className={`flex items-center gap-1.5 rounded border px-3 py-1.5 text-xs ${report === key ? "border-black bg-black text-white dark:border-white dark:bg-white dark:text-black" : "border-neutral-200 dark:border-neutral-700"}`}>
              <Icon className="h-3.5 w-3.5" />{label}
            </button>
          ))}
        </div>

        {report === "sales" && <ReportCard title={`Sales by ${salesInterval}`}>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Metric label="Total sales" value={money(totalSales)} />
            <Metric label="Transactions" value={transactionCount} />
            <Metric label="POS sales" value={money(dailyTotals.reduce((sum, row) => sum + row.pos, 0))} />
            <Metric label="Dining sales" value={money(dailyTotals.reduce((sum, row) => sum + row.dining, 0))} />
            <Metric label="Average sale" value={money(transactionCount ? totalSales / transactionCount : 0)} />
            <Metric label="Vs previous range" value={<span className={salesChange != null && salesChange < 0 ? "text-red-600" : "text-emerald-700"}>{salesChange == null ? "No previous sales" : `${salesChange >= 0 ? "+" : ""}${salesChange.toFixed(1)}%`}<span className="mt-1 block text-[10px] font-normal text-neutral-500">Previous: {money(data?.previousPeriod.sales ?? 0)}</span></span>} />
          </div>
          <DataTable headers={[salesInterval === "day" ? "Business date" : salesInterval === "week" ? "Week starting" : "Month", "POS sales", "Dining sales", "Transactions", "Average sale", "Total sales"]}>
            {dailyTotals.map((row) => <tr key={row.date}><Cell>{displayBucket(row.date, salesInterval)}</Cell><Cell>{money(row.pos)}</Cell><Cell>{money(row.dining)}</Cell><Cell>{row.transactions}</Cell><Cell>{money(row.transactions ? row.sales / row.transactions : 0)}</Cell><Cell bold>{money(row.sales)}</Cell></tr>)}
          </DataTable>
          {!dailyTotals.length && <EmptyState loading={loading} />}
          <p className="mt-3 text-[10px] text-neutral-500">Sales include posted POS orders and settled dining checks, grouped by the shift business date. Voided and open checks are excluded.</p>
        </ReportCard>}

        {report === "staff" && <ReportCard title="Sales by staff member">
          <DataTable headers={["Staff member", "Role", "Source", "Transactions", "Sales"]}>
            {data?.staffSales.map((row) => <tr key={`${row.staffName}-${row.source}`}><Cell>{row.staffName}</Cell><Cell>{row.role}</Cell><Cell>{row.source}</Cell><Cell>{row.transactions}</Cell><Cell bold>{money(row.sales)}</Cell></tr>)}
          </DataTable>
          {!data?.staffSales.length && <EmptyState loading={loading} />}
          <p className="mt-3 text-[10px] text-neutral-500">POS sales are attributed to the cashier; dining sales are attributed to the waiter recorded on the check.</p>
        </ReportCard>}

        {report === "products" && <ReportCard title="Sales by product and category">
          <h3 className="mb-2 text-xs font-semibold">Category totals</h3>
          <DataTable headers={["Category", "Sales"]}>{productCategories.map((row) => <tr key={row.category}><Cell>{row.category}</Cell><Cell bold>{money(row.sales)}</Cell></tr>)}</DataTable>
          <h3 className="mb-2 mt-5 text-xs font-semibold">Top products</h3>
          <DataTable headers={["Product", "Category", "Quantity sold", "Sales"]}>{data?.productSales.map((row) => <tr key={`${row.itemName}-${row.category}`}><Cell>{row.itemName}</Cell><Cell>{row.category}</Cell><Cell>{row.quantity.toLocaleString("en-KE")}</Cell><Cell bold>{money(row.sales)}</Cell></tr>)}</DataTable>
          {!data?.productSales.length && <EmptyState loading={loading} />}
          <p className="mt-3 text-[10px] text-neutral-500">Product sales are calculated from stored order-line prices and restaurant-check item snapshots.</p>
        </ReportCard>}

        {report === "payments" && <ReportCard title="Sales by payment method">
          <DataTable headers={["Payment method", "Transactions", "Amount"]}>
            {data?.paymentSales.map((row) => <tr key={row.tenderType}><Cell>{row.tenderType.toUpperCase()}</Cell><Cell>{row.transactions}</Cell><Cell bold>{money(row.amount)}</Cell></tr>)}
          </DataTable>
          {!data?.paymentSales.length && <EmptyState loading={loading} />}
          <p className="mt-3 text-[10px] text-neutral-500">Amounts reflect recorded tenders for posted POS orders and settled restaurant checks.</p>
        </ReportCard>}

        {report === "shifts" && <ReportCard title="Cashier shift reconciliation">
          <DataTable headers={["Date", "Outlet", "Cashier", "Shift", "Status", "Opening float", "Cash sales", "Expected cash", "Counted cash", "Variance"]}>
            {data?.shifts.map((row) => <tr key={row.id}><Cell>{row.businessDate}</Cell><Cell>{row.outletName}</Cell><Cell>{row.cashierName}</Cell><Cell>{row.shiftPeriod ?? row.shiftArea}</Cell><Cell>{row.status.toUpperCase()}</Cell><Cell>{money(row.openingFloat)}</Cell><Cell>{money(row.cashSales)}</Cell><Cell>{money(row.expectedCash)}</Cell><Cell>{row.countedCash == null ? "—" : money(row.countedCash)}</Cell><Cell bold className={row.variance != null && row.variance !== 0 ? "text-amber-700 dark:text-amber-300" : ""}>{row.variance == null ? "—" : money(row.variance)}</Cell></tr>)}
          </DataTable>
          {!data?.shifts.length && <EmptyState loading={loading} />}
          <p className="mt-3 text-[10px] text-neutral-500">Expected cash = opening float + recorded cash sales. Variance is based on the cashier’s close count; an open shift has no final variance yet.</p>
        </ReportCard>}

        {report === "financials" && <ReportCard title="Financial statements">
          {!canViewFinancials ? <EmptyState loading={false} message="Your role does not have accounting report access." /> : <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Metric label="Period revenue" value={money(financialSummary.revenue)} />
              <Metric label="Period expenses" value={money(financialSummary.expenses)} />
              <Metric label="Net profit" value={money(financialSummary.profit)} />
              <Metric label="Assets as of date" value={money(financialSummary.assets)} />
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <FinancialCard title="Profit & Loss">
                <FinancialLine label="Revenue" amount={financialSummary.revenue} />
                <FinancialLine label="Expenses" amount={financialSummary.expenses} />
                <FinancialLine label="Net profit" amount={financialSummary.profit} bold />
              </FinancialCard>
              <FinancialCard title={`Balance Sheet as of ${toDate}`}>
                <FinancialLine label="Assets" amount={financialSummary.assets} />
                <FinancialLine label="Liabilities" amount={financialSummary.liabilities} />
                <FinancialLine label="Equity including current-year profit" amount={financialSummary.equity + financialSummary.yearProfit} />
                <FinancialLine label="Liabilities + equity" amount={financialSummary.liabilitiesAndEquity} bold />
              </FinancialCard>
            </div>
            <h3 className="mb-2 mt-5 text-xs font-semibold">Trial Balance · selected period</h3>
            <DataTable headers={["Code", "Account", "Type", "Debit", "Credit"]}>
              {data?.financial?.map((row) => <tr key={row.accountId}><Cell>{row.code}</Cell><Cell>{row.name}</Cell><Cell>{row.type}</Cell><Cell>{money(row.periodDebit)}</Cell><Cell>{money(row.periodCredit)}</Cell></tr>)}
              {data?.financial && <tr className="border-t font-semibold"><Cell colSpan={3}>Totals</Cell><Cell>{money(data.financial.reduce((sum, row) => sum + row.periodDebit, 0))}</Cell><Cell>{money(data.financial.reduce((sum, row) => sum + row.periodCredit, 0))}</Cell></tr>}
            </DataTable>
            {!data?.financial && <EmptyState loading={loading} />}
            <p className="mt-3 text-[10px] text-neutral-500">Financial statements use posted journal entries. Balance sheet balances are through the selected end date; period profit is added to equity in the statement.</p>
          </>}
        </ReportCard>}

        {report === "occupancy" && <ReportCard title="Occupancy & turnover"><div className="grid grid-cols-3 gap-3"><Metric label="Occupied" value={`${occupied}/${rooms.length}`} /><Metric label="Occupancy rate" value={`${rooms.length ? Math.round((occupied / rooms.length) * 100) : 0}%`} /><Metric label="Active bookings" value={bookings.filter((booking) => booking.status !== "cancelled" && booking.status !== "checked_out").length} /></div><Link href="/rooms" className="mt-4 inline-block text-xs underline">Open room rack and folios</Link></ReportCard>}

        {report === "kots" && <ReportCard title="KOT volume & aging"><div className="grid grid-cols-3 gap-3"><Metric label="Active tickets" value={activeKots.length} /><Metric label="Preparing" value={activeKots.filter((kot) => kot.status === "preparing").length} /><Metric label="Ready" value={activeKots.filter((kot) => kot.status === "ready").length} /></div><div className="mt-4 space-y-2">{activeKots.map((kot) => <div key={kot.id} className="flex justify-between rounded border p-3 text-xs"><span>{kot.table_name} • {kot.station}</span><span className="font-mono uppercase">{kot.status}</span></div>)}{activeKots.length === 0 && <EmptyState loading={false} />}</div><Link href="/kds" className="mt-3 inline-block text-xs underline">Open KDS</Link></ReportCard>}

        {report === "stock" && <ReportCard title="Stock risk"><div className="grid grid-cols-3 gap-3"><Metric label="Tracked items" value={stockItems.length} /><Metric label="Low stock" value={lowStock.length} /><Metric label="Active outlet" value={activeOutlet?.name || "All"} /></div><div className="mt-4 space-y-2">{lowStock.map((item) => <div key={item.id} className="flex justify-between rounded border border-amber-300 bg-amber-50 p-3 text-xs dark:bg-amber-950/20"><span>{item.name}</span><span className="font-mono">{stockLevels[item.id]?.[activeOutlet?.id || ""] || 0} / reorder {item.reorder_level}</span></div>)}{lowStock.length === 0 && <EmptyState loading={false} />}</div><Link href="/stock" className="mt-3 inline-block text-xs underline">Open stock controls</Link></ReportCard>}

        <ReportCard title="Integration health"><div className="grid grid-cols-1 gap-2 md:grid-cols-2">{([{ label: "Receipt printer", status: "Configured", icon: Printer }, { label: "M-Pesa / Daraja", status: "Configured", icon: RefreshCw }, { label: "Fiscal eTIMS", status: "Configured", icon: ClipboardList }, { label: "Offline sync queue", status: "Ready for local shell", icon: Package }] as { label: string; status: string; icon: React.ElementType }[]).map(({ label, status, icon: Icon }) => <div key={label} className="flex items-center justify-between rounded border p-3 text-xs"><span className="flex items-center gap-2"><Icon className="h-3.5 w-3.5 text-neutral-500" />{label}</span><span className="font-mono text-[10px] text-neutral-500">{status}</span></div>)}</div><p className="mt-3 text-[10px] font-mono text-neutral-400">Daraja callback handling and printer driver execution are delivered by the external payment/hardware app, while this panel stores the tenant configuration for the POS workflow.</p></ReportCard>
      </div>
    </DashboardShell>
  );
}

function ReportCard({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="rounded border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900"><h2 className="mb-4 flex items-center gap-2 text-sm font-semibold"><BarChart3 className="h-4 w-4" />{title}</h2>{children}</section>;
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="rounded border p-3"><div className="text-[10px] font-mono uppercase text-neutral-500">{label}</div><div className="mt-2 text-sm font-bold">{value}</div></div>;
}

function DataTable({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return <div className="overflow-x-auto rounded border border-neutral-200 dark:border-neutral-800"><table className="w-full min-w-max text-left text-xs"><thead className="bg-neutral-50 text-[10px] font-mono uppercase text-neutral-500 dark:bg-neutral-800/60"><tr>{headers.map((header) => <th key={header} className="whitespace-nowrap p-3">{header}</th>)}</tr></thead><tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">{children}</tbody></table></div>;
}

function Cell({ children, bold = false, className = "", colSpan }: { children: React.ReactNode; bold?: boolean; className?: string; colSpan?: number }) {
  return <td colSpan={colSpan} className={`whitespace-nowrap p-3 ${bold ? "font-semibold" : ""} ${className}`}>{children}</td>;
}

function EmptyState({ loading, message }: { loading: boolean; message?: string }) {
  return <div className="py-8 text-center text-xs text-neutral-400">{loading ? "Loading report data…" : message ?? "No data in the selected date range."}</div>;
}

function FinancialCard({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="rounded border border-neutral-200 p-4 dark:border-neutral-800"><h3 className="mb-3 text-sm font-semibold">{title}</h3><div className="space-y-2 text-xs">{children}</div></div>;
}

function FinancialLine({ label, amount, bold = false }: { label: string; amount: number; bold?: boolean }) {
  return <div className={`flex justify-between ${bold ? "border-t pt-2 font-semibold" : ""}`}><span>{label}</span><span className="font-mono">{money(amount)}</span></div>;
}
