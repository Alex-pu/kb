"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { useTenantStore } from "@/lib/store/tenant-store";
import { Download, PackagePlus, Plus, Save, Send, Truck, X } from "lucide-react";

interface PurchaseItem {
  id: string;
  name: string;
  sku: string;
  unit: string;
  item_type: "retail" | "menu" | "supply";
}

interface PurchaseLine {
  id?: string;
  item_id: string;
  item_name?: string;
  unit?: string;
  quantity: number;
  unit_cost: number;
  line_total?: number;
}

interface Purchase {
  id: string;
  supplier_name: string;
  purchase_date: string;
  status: "draft" | "ordered" | "received";
  total: number;
  created_at: string;
  ordered_at: string | null;
  received_at: string | null;
  created_by_name: string;
  ordered_by_name: string | null;
  received_by_name: string | null;
  lines: PurchaseLine[];
}

interface DraftLine {
  item_id: string;
  quantity: string;
  unit_cost: string;
}

interface PurchaseResponse {
  success: boolean;
  message?: string;
  items?: PurchaseItem[];
  purchases?: Purchase[];
  item?: PurchaseItem;
  id?: string;
}

function localDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function money(value: number) {
  return `KSh ${value.toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function statusClass(status: Purchase["status"]) {
  if (status === "received") return "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300";
  if (status === "ordered") return "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300";
  return "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300";
}

function getWeekStart(date: Date) {
  const start = new Date(date);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return localDate(start);
}

export default function PurchasesPage() {
  const { activeOutlet, activeProperty, currentUser, hasPermission, loadStockWorkspace } = useTenantStore();
  const canManagePurchases = hasPermission("inventory:manage");
  const today = useMemo(() => new Date(), []);
  const [fromDate, setFromDate] = useState(localDate(today));
  const [toDate, setToDate] = useState(localDate(today));
  const [statusFilter, setStatusFilter] = useState<"all" | Purchase["status"]>("all");
  const [items, setItems] = useState<PurchaseItem[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [purchaseDate, setPurchaseDate] = useState(localDate(today));
  const [draftLines, setDraftLines] = useState<DraftLine[]>([]);
  const [newItemOpen, setNewItemOpen] = useState(false);
  const [newItemName, setNewItemName] = useState("");
  const [newItemUnit, setNewItemUnit] = useState("each");
  const [itemSearch, setItemSearch] = useState("");

  const filteredItems = useMemo(() => {
    const search = itemSearch.trim().toLocaleLowerCase();
    const addedItemIds = new Set(draftLines.map((line) => line.item_id));
    return items.filter((item) =>
      !addedItemIds.has(item.id) &&
      (!search || `${item.name} ${item.sku}`.toLocaleLowerCase().includes(search))
    );
  }, [draftLines, itemSearch, items]);

  const draftTotal = draftLines.reduce((total, line) => {
    const quantity = Number(line.quantity);
    const unitCost = Number(line.unit_cost);
    return total + (Number.isFinite(quantity) && Number.isFinite(unitCost) ? quantity * unitCost : 0);
  }, 0);

  const loadPurchases = useCallback(async () => {
    if (!activeOutlet?.id) {
      setItems([]);
      setPurchases([]);
      setError("Select an outlet to view purchases.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        outlet_id: activeOutlet.id,
        from: fromDate,
        to: toDate,
        status: statusFilter,
      });
      const response = await fetch(`/api/purchases?${params}`, { credentials: "include" });
      const value = await response.json() as PurchaseResponse;
      if (!response.ok || !value.success || !Array.isArray(value.items) || !Array.isArray(value.purchases)) {
        setError(value.message || "Purchases could not be loaded.");
        setPurchases([]);
        return;
      }
      setItems(value.items);
      setPurchases(value.purchases);
    } catch {
      setError("Could not reach the server. Purchases could not be loaded.");
      setPurchases([]);
    } finally {
      setLoading(false);
    }
  }, [activeOutlet?.id, fromDate, statusFilter, toDate]);

  useEffect(() => {
    void loadPurchases();
  }, [loadPurchases]);

  function startNewDraft() {
    setDraftId(null);
    setDraftKey(crypto.randomUUID());
    setSupplierName("");
    setPurchaseDate(localDate(new Date()));
    setDraftLines([]);
    setFormOpen(true);
    setNewItemOpen(false);
    setMessage(null);
    setError(null);
  }

  function editDraft(purchase: Purchase) {
    setDraftId(purchase.id);
    setDraftKey("");
    setSupplierName(purchase.supplier_name);
    setPurchaseDate(purchase.purchase_date);
    setDraftLines(purchase.lines.map((line) => ({
      item_id: line.item_id,
      quantity: String(line.quantity),
      unit_cost: String(line.unit_cost),
    })));
    setFormOpen(true);
    setNewItemOpen(false);
    setMessage(null);
    setError(null);
  }

  function closeForm() {
    setFormOpen(false);
    setDraftId(null);
    setDraftLines([]);
    setSupplierName("");
    setDraftKey("");
    setError(null);
  }

  function addLine(itemId: string) {
    if (!itemId) return;
    setDraftLines((current) => [...current, { item_id: itemId, quantity: "", unit_cost: "" }]);
    setItemSearch("");
  }

  function updateLine(index: number, field: keyof DraftLine, value: string) {
    setDraftLines((current) => current.map((line, lineIndex) =>
      lineIndex === index ? { ...line, [field]: value } : line
    ));
  }

  async function saveDraft(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeOutlet) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    const payload = {
      action: "save_draft",
      outlet_id: activeOutlet.id,
      supplier_name: supplierName.trim(),
      purchase_date: purchaseDate,
      lines: draftLines.map((line) => ({
        item_id: line.item_id,
        quantity: Number(line.quantity),
        unit_cost: Number(line.unit_cost),
      })),
      ...(draftId ? { purchase_id: draftId } : { idempotency_key: draftKey || crypto.randomUUID() }),
    };
    try {
      const response = await fetch("/api/purchases", {
        method: draftId ? "PUT" : "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const value = await response.json() as PurchaseResponse;
      if (!response.ok || !value.success) {
        setError(value.message || "The purchase draft could not be saved.");
        return;
      }
      setMessage(value.message || "Purchase draft saved.");
      closeForm();
      if (purchaseDate < fromDate || purchaseDate > toDate || statusFilter !== "all") {
        setFromDate(purchaseDate);
        setToDate(purchaseDate);
        setStatusFilter("all");
      } else {
        await loadPurchases();
      }
    } catch {
      setError("Could not reach the server. The purchase draft was not saved.");
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(purchase: Purchase, action: "order" | "receive") {
    if (!activeOutlet) return;
    const prompt = action === "order"
      ? `Mark the purchase from ${purchase.supplier_name} as ordered?`
      : `Receive all ${purchase.lines.length} line(s) from ${purchase.supplier_name} and add the quantities to Central Store?`;
    if (!window.confirm(prompt)) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/purchases", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outlet_id: activeOutlet.id, purchase_id: purchase.id, action }),
      });
      const value = await response.json() as PurchaseResponse;
      if (!response.ok || !value.success) {
        setError(value.message || "The purchase status could not be changed.");
        return;
      }
      setMessage(value.message || "Purchase updated.");
      await loadPurchases();
      if (action === "receive") {
        const stockRefresh = await loadStockWorkspace();
        if (!stockRefresh.success) {
          setError(`Purchase received, but the stock workspace could not refresh: ${stockRefresh.message}`);
        }
      }
    } catch {
      setError("Could not reach the server. The purchase status was not changed.");
    } finally {
      setBusy(false);
    }
  }

  async function discardDraft(purchase: Purchase) {
    if (!activeOutlet || !window.confirm(`Discard the draft purchase from ${purchase.supplier_name}? This cannot be undone.`)) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/purchases", {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outlet_id: activeOutlet.id, purchase_id: purchase.id }),
      });
      const value = await response.json() as PurchaseResponse;
      if (!response.ok || !value.success) {
        setError(value.message || "The purchase draft could not be discarded.");
        return;
      }
      setMessage(value.message || "Purchase draft discarded.");
      await loadPurchases();
    } catch {
      setError("Could not reach the server. The purchase draft was not discarded.");
    } finally {
      setBusy(false);
    }
  }

  async function createStockItem() {
    if (!activeOutlet) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/purchases", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_item",
          outlet_id: activeOutlet.id,
          name: newItemName.trim(),
          unit: newItemUnit.trim() || "each",
        }),
      });
      const value = await response.json() as PurchaseResponse;
      if (!response.ok || !value.success || !value.item) {
        setError(value.message || "The product could not be added.");
        return;
      }
      const item = value.item;
      setItems((current) => [...current, item].sort((a, b) => a.name.localeCompare(b.name)));
      setDraftLines((current) => [...current, { item_id: item.id, quantity: "", unit_cost: "" }]);
      setMessage(`${item.name} added as a stock-only supply.`);
      setNewItemName("");
      setNewItemUnit("each");
      setNewItemOpen(false);
      const stockRefresh = await loadStockWorkspace();
      if (!stockRefresh.success) {
        setError(`Product added, but the stock workspace could not refresh: ${stockRefresh.message}`);
      }
    } catch {
      setError("Could not reach the server. The product was not added.");
    } finally {
      setBusy(false);
    }
  }

  function exportPdf() {
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      setError("Allow pop-ups to open the purchase report for printing or saving as PDF.");
      return;
    }
    const rows = purchases.map((purchase) => `
      <article class="purchase">
        <div class="purchase-heading">
          <div><strong>${escapeHtml(purchase.supplier_name)}</strong><div>${escapeHtml(purchase.purchase_date)} · ${purchase.status.toUpperCase()}</div>
          <div>Saved by ${escapeHtml(purchase.created_by_name)}${purchase.ordered_by_name ? ` · Ordered by ${escapeHtml(purchase.ordered_by_name)}` : ""}${purchase.received_by_name ? ` · Received by ${escapeHtml(purchase.received_by_name)}` : ""}</div></div>
          <strong>${money(purchase.total)}</strong>
        </div>
        <table><thead><tr><th>Product</th><th>Pieces</th><th>Unit price</th><th>Total</th></tr></thead>
          <tbody>${purchase.lines.map((line) => `
            <tr><td>${escapeHtml(line.item_name || "Product")}</td><td>${line.quantity.toLocaleString()}</td>
                <td>${money(line.unit_cost)}</td><td>${money(line.line_total ?? line.quantity * line.unit_cost)}</td></tr>
          `).join("")}</tbody>
        </table>
        <div class="purchase-total">Purchase total: ${money(purchase.total)}</div>
      </article>
    `).join("");
    const propertyName = activeProperty?.name || "Property";
    const exportedBy = currentUser?.full_name || currentUser?.email || "Unknown user";
    const exportedAt = new Date().toLocaleString("en-KE");
    printWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(propertyName)} — Purchase report ${escapeHtml(fromDate)} to ${escapeHtml(toDate)}</title>
      <style>
        body{font:12px Arial,sans-serif;color:#111;margin:24px}
        h1{font-size:22px;margin:0 0 3px}h2{font-size:16px;margin:0 0 4px}p{margin:0 0 5px;color:#555}
        .report-meta{margin-bottom:18px;color:#555;font-size:11px}
        .purchase{page-break-inside:avoid;border-top:1px solid #bbb;padding:12px 0}
        .purchase-heading{display:flex;justify-content:space-between;margin-bottom:8px}
        .purchase-heading div{margin-top:4px;color:#555;font-size:11px}
        table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:6px;border-bottom:1px solid #ddd}
        th:last-child,td:last-child{text-align:right}td:nth-child(2),td:nth-child(3){text-align:right}
        .purchase-total{text-align:right;font-weight:bold;margin-top:8px}
        .grand-total{border-top:2px solid #111;padding-top:10px;text-align:right;font-size:14px;font-weight:bold}
        @media print{body{margin:12mm}}
      </style></head><body><h1>${escapeHtml(propertyName)}</h1><h2>Purchase report</h2>
      <p>${escapeHtml(fromDate)} to ${escapeHtml(toDate)} · Status: ${escapeHtml(statusFilter)}</p>
      <div class="report-meta">Report exported by ${escapeHtml(exportedBy)} · ${escapeHtml(exportedAt)}</div>
      ${rows || "<p>No purchases in this date range and status.</p>"}
      <div class="grand-total">Report total: ${money(purchases.reduce((total, purchase) => total + purchase.total, 0))}</div>
      <script>window.onload=()=>window.print()</script></body></html>`);
    printWindow.document.close();
    setError(null);
  }

  function setDatePreset(preset: "today" | "week" | "custom") {
    if (preset === "today") {
      setFromDate(localDate(new Date()));
      setToDate(localDate(new Date()));
    } else if (preset === "week") {
      setFromDate(getWeekStart(new Date()));
      setToDate(localDate(new Date()));
    }
  }

  const reportTotal = purchases.reduce((total, purchase) => total + purchase.total, 0);

  return (
    <DashboardShell>
      <div className="mx-auto max-w-[1500px] space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 pb-3 dark:border-neutral-800">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Purchases</h1>
            <p className="mt-0.5 text-xs text-neutral-500">Save drafts, mark orders, receive full purchases, and report on purchase costs.</p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={exportPdf} disabled={loading} className="inline-flex items-center gap-1.5 rounded border border-neutral-300 px-3 py-2 text-xs disabled:opacity-50 dark:border-neutral-700">
              <Download className="h-3.5 w-3.5" /> Export PDF
            </button>
            {canManagePurchases && <button type="button" onClick={startNewDraft} className="inline-flex items-center gap-1.5 rounded bg-black px-3 py-2 text-xs font-semibold text-white dark:bg-white dark:text-black">
              <Plus className="h-3.5 w-3.5" /> New purchase
            </button>}
          </div>
        </div>

        <section className="flex flex-wrap items-end gap-3 rounded border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex gap-1">
            <button type="button" onClick={() => setDatePreset("today")} className="rounded border px-2.5 py-2 text-xs dark:border-neutral-700">Daily</button>
            <button type="button" onClick={() => setDatePreset("week")} className="rounded border px-2.5 py-2 text-xs dark:border-neutral-700">Weekly</button>
          </div>
          <label className="text-[10px] font-mono uppercase text-neutral-500">From
            <input type="date" value={fromDate} max={toDate || undefined} onChange={(event) => {
              setFromDate(event.target.value);
            }} className="mt-1 block rounded border bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-800" />
          </label>
          <label className="text-[10px] font-mono uppercase text-neutral-500">To
            <input type="date" value={toDate} min={fromDate || undefined} onChange={(event) => {
              setToDate(event.target.value);
            }} className="mt-1 block rounded border bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-800" />
          </label>
          <label className="text-[10px] font-mono uppercase text-neutral-500">Status
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)} className="mt-1 block rounded border bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-800">
              <option value="all">All statuses</option><option value="draft">Draft</option><option value="ordered">Ordered</option><option value="received">Received</option>
            </select>
          </label>
          <div className="ml-auto text-right text-xs">
            <div className="text-neutral-500">{loading ? "Updating report…" : `${purchases.length} purchase(s)`}</div>
            <div className="mt-0.5 font-semibold">{money(reportTotal)}</div>
          </div>
        </section>

        {message && <div role="status" className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300">{message}</div>}
        {error && <div role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">{error}</div>}

        {formOpen && canManagePurchases && <section className="rounded border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold">{draftId ? "Edit purchase draft" : "New purchase draft"}</h2>
            <button type="button" onClick={closeForm} aria-label="Close purchase form" className="rounded p-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"><X className="h-4 w-4" /></button>
          </div>
          <form onSubmit={saveDraft} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs">Supplier<input required maxLength={255} value={supplierName} onChange={(event) => setSupplierName(event.target.value)} className="block w-full rounded border bg-neutral-50 p-2 dark:border-neutral-700 dark:bg-neutral-800" /></label>
              <label className="space-y-1 text-xs">Purchase date<input required type="date" value={purchaseDate} onChange={(event) => setPurchaseDate(event.target.value)} className="block w-full rounded border bg-neutral-50 p-2 dark:border-neutral-700 dark:bg-neutral-800" /></label>
            </div>

            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-xs font-semibold">Products</h3>
                {canManagePurchases && <button type="button" onClick={() => setNewItemOpen((open) => !open)} className="inline-flex items-center gap-1 rounded border px-2.5 py-1.5 text-xs dark:border-neutral-700">
                  <PackagePlus className="h-3.5 w-3.5" /> Add new product
                </button>}
              </div>
              {newItemOpen && <div className="grid gap-2 rounded border border-dashed p-3 sm:grid-cols-[1fr_10rem_auto] dark:border-neutral-700">
                <input maxLength={255} value={newItemName} onChange={(event) => setNewItemName(event.target.value)} placeholder="Product name" className="rounded border bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-800" />
                <input maxLength={40} value={newItemUnit} onChange={(event) => setNewItemUnit(event.target.value)} placeholder="Unit (e.g. pieces)" className="rounded border bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-800" />
                <button type="button" disabled={busy || !newItemName.trim()} onClick={() => void createStockItem()} className="rounded bg-neutral-800 px-3 py-2 text-xs text-white disabled:opacity-50 dark:bg-neutral-200 dark:text-black">Add stock item</button>
                <p className="text-[10px] text-neutral-500 sm:col-span-3">Creates a stock-only supply with zero opening stock. It won’t be sold through POS.</p>
              </div>}
              <div className="grid gap-2 sm:grid-cols-[1fr_14rem]">
                <input type="search" value={itemSearch} onChange={(event) => setItemSearch(event.target.value)} placeholder="Search products by name or SKU" className="rounded border bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-800" />
                <select value="" onChange={(event) => addLine(event.target.value)} className="rounded border bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-800">
                  <option value="">{filteredItems.length ? "Add existing product…" : "No available products"}</option>
                  {filteredItems.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.sku}</option>)}
                </select>
              </div>
              {draftLines.map((line, index) => {
                const item = items.find((candidate) => candidate.id === line.item_id);
                const lineTotal = Number(line.quantity) * Number(line.unit_cost);
                return <div key={line.item_id} className="grid items-center gap-2 rounded border p-2 sm:grid-cols-[1fr_8rem_9rem_9rem_auto] dark:border-neutral-800">
                  <div className="min-w-0 text-xs font-medium">{item?.name || "Unavailable product"}<div className="text-[10px] text-neutral-500">{item?.unit || "unit"}{item ? ` · ${item.sku}` : ""}</div></div>
                  <label className="text-[10px] text-neutral-500">Pieces<input required type="number" min="0.001" max="1000000" step="0.001" value={line.quantity} onChange={(event) => updateLine(index, "quantity", event.target.value)} className="mt-1 block w-full rounded border bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-800" /></label>
                  <label className="text-[10px] text-neutral-500">Unit price (KES)<input required type="number" min="0" max="1000000000" step="0.01" value={line.unit_cost} onChange={(event) => updateLine(index, "unit_cost", event.target.value)} className="mt-1 block w-full rounded border bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-800" /></label>
                  <div className="text-right text-xs"><div className="text-[10px] text-neutral-500">Line total</div><div className="mt-2 font-semibold">{Number.isFinite(lineTotal) ? money(lineTotal) : money(0)}</div></div>
                  <button type="button" onClick={() => setDraftLines((current) => current.filter((_, lineIndex) => lineIndex !== index))} aria-label={`Remove ${item?.name || "product"}`} className="rounded p-2 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"><X className="h-4 w-4" /></button>
                </div>;
              })}
              {draftLines.length === 0 && <div className="rounded border border-dashed p-5 text-center text-xs text-neutral-500 dark:border-neutral-700">Add at least one product to this purchase.</div>}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3 dark:border-neutral-800">
              <p className="text-xs text-neutral-500">Draft total <strong className="ml-1 text-sm text-neutral-900 dark:text-white">{money(draftTotal)}</strong></p>
              <div className="flex gap-2">
                <button type="button" onClick={closeForm} className="rounded border px-3 py-2 text-xs dark:border-neutral-700">Cancel</button>
                <button disabled={busy || draftLines.length === 0} className="inline-flex items-center gap-1.5 rounded bg-black px-3 py-2 text-xs font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-black">
                  <Save className="h-3.5 w-3.5" /> Save draft
                </button>
              </div>
            </div>
          </form>
        </section>}

        <section className="space-y-3">
          {purchases.map((purchase) => <article key={purchase.id} className="rounded border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
            <header className="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-100 p-4 dark:border-neutral-800">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold">{purchase.supplier_name}</h2>
                  <span className={`rounded border px-2 py-0.5 text-[10px] font-mono uppercase ${statusClass(purchase.status)}`}>{purchase.status}</span>
                </div>
                <p className="mt-1 text-[10px] text-neutral-500">Purchase date: {purchase.purchase_date} · Saved by {purchase.created_by_name}</p>
              </div>
              <div className="text-right">
                <div className="text-[10px] text-neutral-500">Purchase total</div>
                <div className="text-sm font-semibold">{money(purchase.total)}</div>
              </div>
            </header>
            <div className="overflow-x-auto px-4">
              <table className="w-full min-w-[560px] text-left text-xs">
                <thead className="text-[10px] uppercase text-neutral-500"><tr><th className="py-2 font-medium">Product</th><th className="py-2 text-right font-medium">Pieces</th><th className="py-2 text-right font-medium">Unit price</th><th className="py-2 text-right font-medium">Line total</th></tr></thead>
                <tbody>{purchase.lines.map((line) => <tr key={line.id || line.item_id} className="border-t border-neutral-100 dark:border-neutral-800">
                  <td className="py-2 font-medium">{line.item_name}<span className="ml-1 text-[10px] font-normal text-neutral-500">{line.unit}</span></td>
                  <td className="py-2 text-right font-mono">{line.quantity.toLocaleString()}</td>
                  <td className="py-2 text-right">{money(line.unit_cost)}</td>
                  <td className="py-2 text-right font-semibold">{money(line.line_total ?? line.quantity * line.unit_cost)}</td>
                </tr>)}</tbody>
              </table>
            </div>
            {purchase.status === "ordered" && <p className="border-t border-neutral-100 px-4 py-2 text-[10px] text-neutral-500 dark:border-neutral-800">Ordered by {purchase.ordered_by_name || "staff"}{purchase.ordered_at ? ` · ${new Date(purchase.ordered_at).toLocaleString()}` : ""}</p>}
            {purchase.status === "received" && <p className="border-t border-neutral-100 px-4 py-2 text-[10px] text-neutral-500 dark:border-neutral-800">Received by {purchase.received_by_name || "staff"}{purchase.received_at ? ` · ${new Date(purchase.received_at).toLocaleString()}` : ""}. Added to Central Store.</p>}
            {canManagePurchases && <footer className="flex flex-wrap justify-end gap-2 border-t border-neutral-100 p-3 dark:border-neutral-800">
              {purchase.status === "draft" && <>
                <button type="button" disabled={busy} onClick={() => editDraft(purchase)} className="rounded border px-3 py-1.5 text-xs disabled:opacity-50 dark:border-neutral-700">Edit draft</button>
                <button type="button" disabled={busy} onClick={() => void discardDraft(purchase)} className="rounded border border-red-300 px-3 py-1.5 text-xs text-red-700 disabled:opacity-50 dark:border-red-900 dark:text-red-300">Discard draft</button>
                <button type="button" disabled={busy} onClick={() => void changeStatus(purchase, "order")} className="inline-flex items-center gap-1.5 rounded border border-blue-300 px-3 py-1.5 text-xs text-blue-700 disabled:opacity-50 dark:border-blue-900 dark:text-blue-300"><Send className="h-3.5 w-3.5" /> Mark ordered</button>
              </>}
              {purchase.status === "ordered" && <button type="button" disabled={busy} onClick={() => void changeStatus(purchase, "receive")} className="inline-flex items-center gap-1.5 rounded bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"><Truck className="h-3.5 w-3.5" /> Receive all products</button>}
            </footer>}
          </article>)}
          {!loading && purchases.length === 0 && <div className="rounded border border-dashed border-neutral-300 p-8 text-center text-xs text-neutral-500 dark:border-neutral-700">
            No purchases match the selected date and status filters.
          </div>}
        </section>
      </div>
    </DashboardShell>
  );
}
