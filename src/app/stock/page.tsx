"use client";

import React, { useEffect, useMemo, useState } from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { useTenantStore } from "@/lib/store/tenant-store";
import { AlertTriangle, ArrowLeftRight, PackagePlus, Plus, Trash2, X } from "lucide-react";
import type { StockItem, StockRequisition } from "@/lib/types/database";

type Warehouse = "kitchen" | "bar" | "supplies";
type RequestLineDraft = { item_id: string; quantity: string };

function formatQuantity(value: number) {
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function warehouseLabel(warehouse: "central" | Warehouse) {
  if (warehouse === "central") return "Central Store";
  if (warehouse === "supplies") return "Supplies";
  return warehouse === "bar" ? "Bar" : "Kitchen";
}

function requestStatusClass(status: StockRequisition["status"]) {
  if (status === "fulfilled") return "text-emerald-600";
  if (status === "rejected" || status === "cancelled") return "text-neutral-500";
  return "text-amber-600";
}

export default function StockPage() {
  const {
    activeOutlet,
    currentUser,
    stockItems,
    stockMovements,
    stockRequisitions,
    loadStockWorkspace,
    hasPermission,
  } = useTenantStore();
  const canManageStock = hasPermission("inventory:manage");
  const canRequestStock = hasPermission("inventory:request");

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [purchaseSearch, setPurchaseSearch] = useState("");
  const [purchaseForm, setPurchaseForm] = useState({ item_id: "", supplier_name: "", quantity: "", unit_cost: "" });
  const [transferForm, setTransferForm] = useState({ item_id: "", warehouse: "kitchen" as Warehouse, quantity: "" });
  const [wastageForm, setWastageForm] = useState({ item_id: "", warehouse: "kitchen" as Warehouse, quantity: "", reason: "" });
  const [requestForm, setRequestForm] = useState({
    warehouse: "kitchen" as Warehouse,
    note: "",
    lines: [{ item_id: "", quantity: "" }] as RequestLineDraft[],
  });
  const [fulfillmentQuantities, setFulfillmentQuantities] = useState<Record<string, string>>({});
  const [rejectionReasons, setRejectionReasons] = useState<Record<string, string>>({});

  const trackedItems = useMemo(() => stockItems.filter((item) => item.stock_tracked), [stockItems]);
  const outletItems = useMemo(() => trackedItems.filter((item) => item.available_at_outlet), [trackedItems]);
  const purchaseItems = useMemo(() => {
    const search = purchaseSearch.trim().toLocaleLowerCase();
    if (!search) return trackedItems;
    return trackedItems.filter((item) =>
      `${item.name} ${item.sku}`.toLocaleLowerCase().includes(search)
    );
  }, [purchaseSearch, trackedItems]);
  const itemsForWarehouse = (warehouse: Warehouse, items = trackedItems) =>
    items.filter((item) => (item.item_type === "supply") === (warehouse === "supplies"));
  const outletId = activeOutlet?.id || "";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void loadStockWorkspace().then((result) => {
      if (cancelled) return;
      setError(result.success ? null : result.message);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [activeOutlet?.id, loadStockWorkspace]);

  async function postAction(payload: Record<string, unknown>) {
    if (!activeOutlet) {
      setError("Select an outlet before changing stock.");
      return false;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/stock", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          outlet_id: activeOutlet.id,
          idempotency_key: `stock-${crypto.randomUUID()}`,
        }),
      });
      const value: unknown = await response.json();
      if (typeof value !== "object" || value === null || !("success" in value) || value.success !== true) {
        const message = typeof value === "object" && value !== null && "message" in value && typeof value.message === "string"
          ? value.message
          : "The stock action could not be completed.";
        setError(message);
        return false;
      }
      const result = value as { success: boolean; message?: string };
      setMessage(result.message || "Stock action recorded.");
      const refresh = await loadStockWorkspace();
      if (!refresh.success) {
        setError(`Stock action was recorded, but the workspace could not refresh: ${refresh.message}`);
      }
      return true;
    } catch {
      setError("Could not reach the server. The stock action was not recorded.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submitPurchase(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const success = await postAction({
      action: "receive",
      item_id: purchaseForm.item_id,
      supplier_name: purchaseForm.supplier_name,
      quantity: Number(purchaseForm.quantity),
      unit_cost: Number(purchaseForm.unit_cost),
    });
    if (success) {
      setPurchaseForm({ item_id: "", supplier_name: "", quantity: "", unit_cost: "" });
      setPurchaseSearch("");
    }
  }

  async function submitTransfer(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const success = await postAction({
      action: "transfer",
      item_id: transferForm.item_id,
      warehouse: transferForm.warehouse,
      quantity: Number(transferForm.quantity),
    });
    if (success) setTransferForm({ item_id: "", warehouse: "kitchen", quantity: "" });
  }

  async function submitWastage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const success = await postAction({
      action: "wastage",
      item_id: wastageForm.item_id,
      warehouse: wastageForm.warehouse,
      quantity: Number(wastageForm.quantity),
      reason: wastageForm.reason,
    });
    if (success) setWastageForm({ item_id: "", warehouse: "kitchen", quantity: "", reason: "" });
  }

  async function submitRequest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const success = await postAction({
      action: "request",
      warehouse: requestForm.warehouse,
      note: requestForm.note,
      lines: requestForm.lines.map((line) => ({ item_id: line.item_id, quantity: Number(line.quantity) })),
    });
    if (success) {
      setRequestForm({ warehouse: "kitchen", note: "", lines: [{ item_id: "", quantity: "" }] });
    }
  }

  const updateRequestLine = (index: number, key: keyof RequestLineDraft, value: string) => {
    setRequestForm((current) => ({
      ...current,
      lines: current.lines.map((line, lineIndex) => lineIndex === index ? { ...line, [key]: value } : line),
    }));
  };

  const movementDescription = (movement: typeof stockMovements[number]) => {
    if (movement.movement_type === "purchase_receipt") {
      return `Received ${formatQuantity(movement.quantity)} ${movement.unit} into Central Store from ${movement.supplier_name}.`;
    }
    if (movement.movement_type === "stock_transfer") {
      return `Transferred ${formatQuantity(movement.quantity)} ${movement.unit} from Central Store to ${movement.destination_outlet_name || activeOutlet?.name} / ${warehouseLabel(movement.destination_warehouse || "kitchen")}.`;
    }
    if (movement.movement_type === "wastage") {
      return `Recorded ${formatQuantity(movement.quantity)} ${movement.unit} wastage from ${movement.source_outlet_name || activeOutlet?.name} / ${warehouseLabel(movement.source_warehouse || "kitchen")}: ${movement.reason}.`;
    }
    if (movement.movement_type === "opening_balance") {
      return `Set opening balance of ${formatQuantity(movement.quantity)} ${movement.unit} at ${movement.destination_outlet_name || activeOutlet?.name} / ${warehouseLabel(movement.destination_warehouse || "kitchen")}.`;
    }
    return `Sold ${formatQuantity(movement.quantity)} ${movement.unit} from ${movement.source_outlet_name || activeOutlet?.name} / ${warehouseLabel(movement.source_warehouse || "kitchen")}.`;
  };

  return (
    <DashboardShell>
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="border-b border-neutral-200 dark:border-neutral-800 pb-3">
          <h1 className="text-xl font-bold tracking-tight">Stock & Supplies</h1>
          <p className="text-xs text-neutral-500 font-mono mt-0.5">
              Property-wide Central Store • {activeOutlet?.name || "Select an outlet"} • Kitchen, Bar and Supplies balances
          </p>
        </div>

        {error && <div role="alert" className="px-3 py-2 text-xs border border-red-300 text-red-700 rounded">{error}</div>}
        {message && <div role="status" className="px-3 py-2 text-xs border border-neutral-200 dark:border-neutral-700 rounded">{message}</div>}
        {loading && <p className="text-xs text-neutral-500">Loading persistent stock records…</p>}

        <section className="space-y-2">
          <h2 className="text-xs font-mono font-semibold uppercase tracking-wider text-neutral-500">Stock balances</h2>
          <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-neutral-50 dark:bg-neutral-800/60 text-[11px] font-mono uppercase text-neutral-500">
                <tr>
                  <th className="p-3">Item</th><th className="p-3">Central Store</th><th className="p-3">Kitchen</th>
                  <th className="p-3">Bar</th><th className="p-3">Supplies</th><th className="p-3">Order destination</th><th className="p-3">Outlet status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {trackedItems.map((item) => {
                  const routedQuantity = item.item_type === "supply"
                    ? item.supplies_quantity
                    : item.prep_station === "bar" ? item.bar_quantity : item.kitchen_quantity;
                  const status = !item.available_at_outlet
                    ? "Not transferred"
                    : routedQuantity <= item.reorder_level
                      ? "Low stock"
                      : "OK";
                  return (
                    <tr key={item.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-800/30">
                      <td className="p-3 font-semibold">{item.name}<div className="text-[10px] font-mono text-neutral-400">{item.unit} • reorder {item.reorder_level}</div></td>
                      <td className="p-3 font-mono">{formatQuantity(item.central_quantity)} {item.unit}</td>
                      <td className="p-3 font-mono">{formatQuantity(item.kitchen_quantity)} {item.unit}</td>
                      <td className="p-3 font-mono">{formatQuantity(item.bar_quantity)} {item.unit}</td>
                      <td className="p-3 font-mono">{item.item_type === "supply" ? `${formatQuantity(item.supplies_quantity)} ${item.unit}` : "—"}</td>
                      <td className="p-3">{item.item_type === "supply" ? "Supplies" : warehouseLabel(item.prep_station)}</td>
                      <td className={`p-3 text-[10px] font-mono ${status === "Low stock" ? "text-red-600" : status === "OK" ? "text-emerald-600" : "text-neutral-400"}`}>
                        {status === "Low stock" && <AlertTriangle className="inline w-3 h-3 mr-1" />}
                        {status}
                      </td>
                    </tr>
                  );
                })}
                {!loading && trackedItems.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-neutral-400">No stock-tracked products in this property catalog.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        {canManageStock && (
          <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <form onSubmit={submitPurchase} className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-3">
              <h3 className="text-xs font-semibold flex items-center gap-1.5"><PackagePlus className="w-3.5 h-3.5" /> Receive purchase</h3>
              <input
                type="search"
                aria-label="Search purchase items"
                value={purchaseSearch}
                onChange={(event) => {
                  setPurchaseSearch(event.target.value);
                  setPurchaseForm((current) => ({ ...current, item_id: "" }));
                }}
                placeholder="Search product or menu item by name or SKU"
                className="w-full p-2 text-xs border rounded bg-neutral-50 dark:bg-neutral-800"
              />
              <select required value={purchaseForm.item_id} onChange={(event) => setPurchaseForm({ ...purchaseForm, item_id: event.target.value })} className="w-full p-2 text-xs border rounded bg-neutral-50 dark:bg-neutral-800">
                <option value="">{purchaseItems.length ? "Select stock-tracked catalog item" : "No matching stock-tracked items"}</option>
                {purchaseItems.map((item) => <option key={item.id} value={item.id}>{item.name} • {item.sku} ({item.unit})</option>)}
              </select>
              <input required maxLength={255} value={purchaseForm.supplier_name} onChange={(event) => setPurchaseForm({ ...purchaseForm, supplier_name: event.target.value })} placeholder="Supplier name" className="w-full p-2 text-xs border rounded bg-neutral-50 dark:bg-neutral-800" />
              <div className="grid grid-cols-2 gap-2">
                <input required type="number" min="0.001" step="0.001" value={purchaseForm.quantity} onChange={(event) => setPurchaseForm({ ...purchaseForm, quantity: event.target.value })} placeholder="Quantity" className="w-full p-2 text-xs border rounded bg-neutral-50 dark:bg-neutral-800" />
                <input required type="number" min="0" step="0.01" value={purchaseForm.unit_cost} onChange={(event) => setPurchaseForm({ ...purchaseForm, unit_cost: event.target.value })} placeholder="Unit cost (KES)" className="w-full p-2 text-xs border rounded bg-neutral-50 dark:bg-neutral-800" />
              </div>
              <button disabled={busy || trackedItems.length === 0} className="w-full py-2 bg-black text-white dark:bg-white dark:text-black rounded text-xs font-semibold disabled:opacity-50">Receive into Central Store</button>
            </form>

            <form onSubmit={submitTransfer} className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-3">
              <h3 className="text-xs font-semibold flex items-center gap-1.5"><ArrowLeftRight className="w-3.5 h-3.5" /> Transfer to outlet</h3>
              <select required value={transferForm.item_id} onChange={(event) => setTransferForm({ ...transferForm, item_id: event.target.value })} className="w-full p-2 text-xs border rounded bg-neutral-50 dark:bg-neutral-800">
                <option value="">Select item</option>
                {itemsForWarehouse(transferForm.warehouse).map((item) => <option key={item.id} value={item.id}>{item.name} • Central {formatQuantity(item.central_quantity)} {item.unit}</option>)}
              </select>
              <select value={transferForm.warehouse} onChange={(event) => setTransferForm({ ...transferForm, warehouse: event.target.value as Warehouse, item_id: "" })} className="w-full p-2 text-xs border rounded bg-neutral-50 dark:bg-neutral-800">
                <option value="kitchen">Kitchen</option><option value="bar">Bar</option><option value="supplies">Supplies</option>
              </select>
              <input required type="number" min="0.001" step="0.001" value={transferForm.quantity} onChange={(event) => setTransferForm({ ...transferForm, quantity: event.target.value })} placeholder="Quantity" className="w-full p-2 text-xs border rounded bg-neutral-50 dark:bg-neutral-800" />
              <button disabled={busy || trackedItems.length === 0} className="w-full py-2 bg-black text-white dark:bg-white dark:text-black rounded text-xs font-semibold disabled:opacity-50">Transfer from Central Store</button>
            </form>

            <form onSubmit={submitWastage} className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-3">
              <h3 className="text-xs font-semibold flex items-center gap-1.5"><Trash2 className="w-3.5 h-3.5" /> Record wastage</h3>
              <select required value={wastageForm.item_id} onChange={(event) => setWastageForm({ ...wastageForm, item_id: event.target.value })} className="w-full p-2 text-xs border rounded bg-neutral-50 dark:bg-neutral-800">
                <option value="">Select item at this outlet</option>
                {itemsForWarehouse(wastageForm.warehouse, outletItems).map((item) => <option key={item.id} value={item.id}>{item.name} ({item.unit})</option>)}
              </select>
              <select value={wastageForm.warehouse} onChange={(event) => setWastageForm({ ...wastageForm, warehouse: event.target.value as Warehouse, item_id: "" })} className="w-full p-2 text-xs border rounded bg-neutral-50 dark:bg-neutral-800">
                <option value="kitchen">Kitchen</option><option value="bar">Bar</option><option value="supplies">Supplies</option>
              </select>
              <input required type="number" min="0.001" step="0.001" value={wastageForm.quantity} onChange={(event) => setWastageForm({ ...wastageForm, quantity: event.target.value })} placeholder="Quantity" className="w-full p-2 text-xs border rounded bg-neutral-50 dark:bg-neutral-800" />
              <input required maxLength={500} value={wastageForm.reason} onChange={(event) => setWastageForm({ ...wastageForm, reason: event.target.value })} placeholder="Reason (required)" className="w-full p-2 text-xs border rounded bg-neutral-50 dark:bg-neutral-800" />
              <button disabled={busy || outletItems.length === 0} className="w-full py-2 border border-neutral-300 dark:border-neutral-700 rounded text-xs font-semibold disabled:opacity-50">Record outlet wastage</button>
            </form>
          </section>
        )}

        {canRequestStock && (
          <section className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-3">
            <h2 className="text-xs font-semibold">Request stock from Central Store</h2>
            <form onSubmit={submitRequest} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <label className="text-xs space-y-1">Deliver to<select value={requestForm.warehouse} onChange={(event) => setRequestForm({ ...requestForm, warehouse: event.target.value as Warehouse, lines: requestForm.lines.map((line) => ({ ...line, item_id: "" })) })} className="w-full p-2 border rounded bg-neutral-50 dark:bg-neutral-800"><option value="kitchen">Kitchen</option><option value="bar">Bar</option><option value="supplies">Supplies</option></select></label>
                <label className="text-xs space-y-1">Note (optional)<input maxLength={500} value={requestForm.note} onChange={(event) => setRequestForm({ ...requestForm, note: event.target.value })} placeholder="Reason or service period" className="w-full p-2 border rounded bg-neutral-50 dark:bg-neutral-800" /></label>
              </div>
              <div className="space-y-2">
                {requestForm.lines.map((line, index) => (
                  <div key={index} className="grid grid-cols-[1fr_8rem_auto] gap-2">
                    <select required value={line.item_id} onChange={(event) => updateRequestLine(index, "item_id", event.target.value)} className="p-2 text-xs border rounded bg-neutral-50 dark:bg-neutral-800">
                      <option value="">Select item</option>
                      {trackedItems.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.unit})</option>)}
                    </select>
                    <input required type="number" min="0.001" step="0.001" value={line.quantity} onChange={(event) => updateRequestLine(index, "quantity", event.target.value)} placeholder="Quantity" className="p-2 text-xs border rounded bg-neutral-50 dark:bg-neutral-800" />
                    <button type="button" aria-label="Remove item" disabled={requestForm.lines.length <= 1} onClick={() => setRequestForm((current) => ({ ...current, lines: current.lines.filter((_, lineIndex) => lineIndex !== index) }))} className="p-2 border rounded disabled:opacity-30"><X className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => setRequestForm((current) => ({ ...current, lines: [...current.lines, { item_id: "", quantity: "" }] }))} className="flex items-center gap-1 px-2 py-1.5 border rounded text-xs"><Plus className="w-3 h-3" /> Add item</button>
                <button disabled={busy || trackedItems.length === 0} className="px-3 py-1.5 bg-black text-white dark:bg-white dark:text-black rounded text-xs font-semibold disabled:opacity-50">Submit stock request</button>
              </div>
            </form>
          </section>
        )}

        <section className="space-y-2">
          <h2 className="text-xs font-mono font-semibold uppercase tracking-wider text-neutral-500">Stock requests</h2>
          <div className="space-y-2">
            {stockRequisitions.map((requisition) => {
              const active = requisition.status === "pending" || requisition.status === "partially_fulfilled";
              const canCancel = active && (canManageStock || requisition.requester_id === currentUser?.id);
              return (
                <article key={requisition.id} className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-3 space-y-2">
                  <div className="flex flex-wrap justify-between gap-2">
                    <div className="text-xs font-semibold">{requisition.outlet_name} → {warehouseLabel(requisition.destination_warehouse)}<span className="ml-2 text-neutral-500 font-normal">by {requisition.requester_name}</span></div>
                    <span className={`text-[10px] uppercase font-mono ${requestStatusClass(requisition.status)}`}>{requisition.status.replace("_", " ")}</span>
                  </div>
                  {requisition.note && <p className="text-xs text-neutral-500">{requisition.note}</p>}
                  {requisition.rejection_reason && <p className="text-xs text-red-600">Reason: {requisition.rejection_reason}</p>}
                  <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
                    {requisition.lines.map((line) => {
                      const remaining = line.quantity_requested - line.quantity_fulfilled;
                      const key = `${requisition.id}:${line.item_id}`;
                      return (
                        <div key={line.item_id} className="py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                          <span>{line.item_name} • {formatQuantity(line.quantity_fulfilled)} / {formatQuantity(line.quantity_requested)} {line.unit} issued</span>
                          {canManageStock && active && remaining > 0 && (
                            <div className="flex items-center gap-1">
                              <input aria-label={`Fulfill ${line.item_name}`} type="number" min="0.001" max={remaining} step="0.001" value={fulfillmentQuantities[key] ?? formatQuantity(remaining)} onChange={(event) => setFulfillmentQuantities((current) => ({ ...current, [key]: event.target.value }))} className="w-24 p-1.5 border rounded bg-neutral-50 dark:bg-neutral-800" />
                              <button disabled={busy} onClick={() => { void postAction({ action: "fulfill", requisition_id: requisition.id, item_id: line.item_id, quantity: Number(fulfillmentQuantities[key] ?? remaining) }); }} className="px-2 py-1.5 bg-black text-white dark:bg-white dark:text-black rounded disabled:opacity-50">Issue</button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {canCancel && (
                    <div className="flex flex-wrap items-center gap-2 border-t border-neutral-100 dark:border-neutral-800 pt-2">
                      {canManageStock && (
                        <>
                          <input aria-label="Rejection reason" maxLength={500} value={rejectionReasons[requisition.id] ?? ""} onChange={(event) => setRejectionReasons((current) => ({ ...current, [requisition.id]: event.target.value }))} placeholder="Reason to reject" className="p-1.5 text-xs border rounded bg-neutral-50 dark:bg-neutral-800" />
                          <button disabled={busy || !(rejectionReasons[requisition.id] ?? "").trim()} onClick={() => { void postAction({ action: "reject", requisition_id: requisition.id, reason: rejectionReasons[requisition.id] }); }} className="px-2 py-1.5 border rounded text-xs disabled:opacity-50">Reject request</button>
                        </>
                      )}
                      <button disabled={busy} onClick={() => { void postAction({ action: "cancel", requisition_id: requisition.id }); }} className="px-2 py-1.5 border rounded text-xs disabled:opacity-50">Cancel request</button>
                    </div>
                  )}
                </article>
              );
            })}
            {!loading && stockRequisitions.length === 0 && <p className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-4 text-xs text-neutral-400">No stock requests have been submitted.</p>}
          </div>
        </section>

        <section className="space-y-2">
          <h2 className="text-xs font-mono font-semibold uppercase tracking-wider text-neutral-500">Movement history</h2>
          <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-4 text-xs space-y-2 max-h-80 overflow-y-auto">
            {stockMovements.map((movement) => (
              <div key={movement.id} className="flex flex-wrap justify-between gap-x-4 gap-y-1 border-b last:border-0 border-neutral-100 dark:border-neutral-800 pb-2">
                <span className="text-neutral-700 dark:text-neutral-300">{movementDescription(movement)}</span>
                <span className="text-[10px] font-mono text-neutral-400">{movement.actor_name} • {new Date(movement.created_at).toLocaleString()}</span>
              </div>
            ))}
            {!loading && stockMovements.length === 0 && <div className="text-neutral-400">No stock movements recorded yet.</div>}
          </div>
        </section>
      </div>
    </DashboardShell>
  );
}
