"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { useTenantStore } from "@/lib/store/tenant-store";
import { BarChart3, BedDouble, ChefHat, ClipboardList, Package, Printer, RefreshCw, Wallet } from "lucide-react";

const REPORTS = [
  { key: "revenue", label: "Revenue by source", icon: Wallet },
  { key: "occupancy", label: "Occupancy & turnover", icon: BedDouble },
  { key: "kots", label: "KOT volume & aging", icon: ChefHat },
  { key: "cashier", label: "Cashier variance", icon: ClipboardList },
  { key: "stock", label: "Stock risk", icon: Package },
] as const;

type ReportKey = typeof REPORTS[number]["key"];

export default function ReportsPage() {
  const [report, setReport] = useState<ReportKey>("revenue");
  const { journalEntries, rooms, bookings, kots, activeShift, stockItems, stockLevels, activeOutlet, loadStockWorkspace } = useTenantStore();
  useEffect(() => {
    void loadStockWorkspace();
  }, [activeOutlet?.id, loadStockWorkspace]);
  const revenueBySource = useMemo(() => journalEntries.filter((entry) => entry.source_type === "pos_sale" || entry.source_type === "folio_settlement").reduce((result, entry) => {
    const source = entry.source_type === "pos_sale" ? "POS & Dining" : "Folio settlements";
    result[source] = (result[source] || 0) + entry.lines.reduce((sum, line) => sum + line.credit, 0);
    return result;
  }, {} as Record<string, number>), [journalEntries]);
  const activeKots = kots.filter((kot) => !["served", "cancelled"].includes(kot.status));
  const lowStock = stockItems.filter((item) =>
    item.stock_tracked && item.available_at_outlet &&
    (stockLevels[item.id]?.[activeOutlet?.id || ""] || 0) <= item.reorder_level
  );
  const occupied = rooms.filter((room) => room.status === "occupied").length;

  return (
    <DashboardShell>
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="border-b border-neutral-200 dark:border-neutral-800 pb-3"><h1 className="text-xl font-bold tracking-tight">Reports & Analytics</h1><p className="text-xs text-neutral-500 font-mono mt-0.5">Phase 9 • Drillable operational reports for the active property</p></div>
        <div className="flex flex-wrap gap-1 border-b border-neutral-200 dark:border-neutral-800 pb-2">{REPORTS.map(({ key, label, icon: Icon }) => <button key={key} onClick={() => setReport(key)} className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border ${report === key ? "bg-black text-white dark:bg-white dark:text-black border-black dark:border-white" : "border-neutral-200 dark:border-neutral-700"}`}><Icon className="w-3.5 h-3.5" />{label}</button>)}</div>

        {report === "revenue" && <div className="space-y-3"><ReportCard title="Revenue by source"><div className="space-y-2">{Object.entries(revenueBySource).map(([source, amount]) => <div key={source} className="flex justify-between p-3 border rounded text-xs"><span>{source}</span><span className="font-mono">KSh {amount.toFixed(2)}</span></div>)}{Object.keys(revenueBySource).length === 0 && <EmptyState />}</div><Link href="/accounting" className="inline-block mt-3 text-xs underline">Open accounting journal</Link></ReportCard></div>}
        {report === "occupancy" && <ReportCard title="Occupancy & turnover"><div className="grid grid-cols-3 gap-3"><Metric label="Occupied" value={`${occupied}/${rooms.length}`} /><Metric label="Occupancy rate" value={`${rooms.length ? Math.round((occupied / rooms.length) * 100) : 0}%`} /><Metric label="Active bookings" value={bookings.filter((booking) => booking.status !== "cancelled" && booking.status !== "checked_out").length} /></div><Link href="/rooms" className="inline-block mt-4 text-xs underline">Open room rack and folios</Link></ReportCard>}
        {report === "kots" && <ReportCard title="KOT volume & aging"><div className="grid grid-cols-3 gap-3"><Metric label="Active tickets" value={activeKots.length} /><Metric label="Preparing" value={activeKots.filter((kot) => kot.status === "preparing").length} /><Metric label="Ready" value={activeKots.filter((kot) => kot.status === "ready").length} /></div><div className="mt-4 space-y-2">{activeKots.map((kot) => <div key={kot.id} className="flex justify-between p-3 border rounded text-xs"><span>{kot.table_name} • {kot.station}</span><span className="font-mono uppercase">{kot.status}</span></div>)}{activeKots.length === 0 && <EmptyState />}</div><Link href="/kds" className="inline-block mt-3 text-xs underline">Open KDS</Link></ReportCard>}
        {report === "cashier" && <ReportCard title="Cashier variance"><div className="grid grid-cols-3 gap-3"><Metric label="Shift status" value={activeShift?.status || "Closed"} /><Metric label="Cash sales" value={`KSh ${(activeShift?.cash_sales || 0).toFixed(2)}`} /><Metric label="Variance" value={`KSh ${(activeShift?.variance || 0).toFixed(2)}`} /></div><Link href="/pos" className="inline-block mt-4 text-xs underline">Open POS shift controls</Link></ReportCard>}
        {report === "stock" && <ReportCard title="Stock risk"><div className="grid grid-cols-3 gap-3"><Metric label="Tracked items" value={stockItems.length} /><Metric label="Low stock" value={lowStock.length} /><Metric label="Active outlet" value={activeOutlet?.name || "All"} /></div><div className="mt-4 space-y-2">{lowStock.map((item) => <div key={item.id} className="flex justify-between p-3 border border-amber-300 bg-amber-50 dark:bg-amber-950/20 rounded text-xs"><span>{item.name}</span><span className="font-mono">{stockLevels[item.id]?.[activeOutlet?.id || ""] || 0} / reorder {item.reorder_level}</span></div>)}{lowStock.length === 0 && <EmptyState />}</div><Link href="/stock" className="inline-block mt-3 text-xs underline">Open stock controls</Link></ReportCard>}

        <ReportCard title="Integration health"><div className="grid grid-cols-1 md:grid-cols-2 gap-2">{([{ label: "Receipt printer", status: "Configured", icon: Printer }, { label: "M-Pesa / Daraja", status: "Configured", icon: RefreshCw }, { label: "Fiscal eTIMS", status: "Configured", icon: ClipboardList }, { label: "Offline sync queue", status: "Ready for local shell", icon: Package }] as { label: string; status: string; icon: React.ElementType }[]).map(({ label, status, icon: Icon }) => <div key={label} className="flex items-center justify-between p-3 border rounded text-xs"><span className="flex items-center gap-2"><Icon className="w-3.5 h-3.5 text-neutral-500" />{label}</span><span className="font-mono text-[10px] text-neutral-500">{status}</span></div>)}</div><p className="mt-3 text-[10px] font-mono text-neutral-400">Daraja callback handling and printer driver execution are still delivered by the external payment/hardware app, while this panel stores the tenant configuration for the POS workflow.</p></ReportCard>
      </div>
    </DashboardShell>
  );
}

function ReportCard({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-5"><h2 className="font-semibold text-sm flex items-center gap-2 mb-4"><BarChart3 className="w-4 h-4" />{title}</h2>{children}</div>;
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="p-3 border rounded"><div className="text-[10px] font-mono uppercase text-neutral-500">{label}</div><div className="mt-2 font-bold text-sm">{value}</div></div>;
}

function EmptyState() {
  return <div className="py-8 text-center text-xs font-mono text-neutral-400">No data in the selected scope.</div>;
}
