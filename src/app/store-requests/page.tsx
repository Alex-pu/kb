"use client";

import React, { useCallback, useEffect, useState } from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { useTenantStore } from "@/lib/store/tenant-store";
import type { StockRequisition } from "@/lib/types/database";
import { ClipboardList, Plus, X } from "lucide-react";

interface SupplyOption {
  id: string;
  name: string;
  sku: string;
  unit: string;
}

interface RequestLineDraft {
  item_id: string;
  quantity: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quantity(value: number) {
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function requestStatusClass(status: StockRequisition["status"]) {
  if (status === "fulfilled") return "text-emerald-600";
  if (status === "rejected" || status === "cancelled") return "text-neutral-500";
  return "text-amber-600";
}

export default function StoreRequestsPage() {
  const { activeOutlet } = useTenantStore();
  const outletId = activeOutlet?.id;
  const [supplies, setSupplies] = useState<SupplyOption[]>([]);
  const [requests, setRequests] = useState<StockRequisition[]>([]);
  const [lines, setLines] = useState<RequestLineDraft[]>([{ item_id: "", quantity: "" }]);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!outletId) {
      setSupplies([]);
      setRequests([]);
      return { success: false, message: "Select an outlet before viewing store requests." };
    }
    try {
      const response = await fetch(`/api/stock/requests?outlet_id=${encodeURIComponent(outletId)}`, {
        credentials: "include",
      });
      const value: unknown = await response.json();
      if (!response.ok || !isRecord(value) || value.success !== true ||
          !Array.isArray(value.supplies) || !Array.isArray(value.requests)) {
        const detail = isRecord(value) && typeof value.message === "string"
          ? value.message
          : "Store requests could not be loaded.";
        setSupplies([]);
        setRequests([]);
        return { success: false, message: detail };
      }

      const nextSupplies = value.supplies.filter((item): item is SupplyOption =>
        isRecord(item) && typeof item.id === "string" && typeof item.name === "string" &&
        typeof item.sku === "string" && typeof item.unit === "string"
      );
      setSupplies(nextSupplies);
      setRequests(value.requests as StockRequisition[]);
      return { success: true, message: "Store requests loaded." };
    } catch {
      setSupplies([]);
      setRequests([]);
      return { success: false, message: "Could not reach the server. Store requests could not be loaded." };
    }
  }, [outletId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void refresh().then((result) => {
      if (cancelled) return;
      setError(result.success ? null : result.message);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [refresh]);

  async function postRequest(payload: Record<string, unknown>) {
    if (!outletId) {
      setError("Select an outlet before requesting supplies.");
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
          outlet_id: outletId,
          idempotency_key: `supply-request-${crypto.randomUUID()}`,
        }),
      });
      const value: unknown = await response.json();
      if (!response.ok || !isRecord(value) || value.success !== true) {
        setError(isRecord(value) && typeof value.message === "string"
          ? value.message
          : "The supply request could not be completed.");
        return false;
      }
      setMessage(typeof value.message === "string" ? value.message : "Supply request updated.");
      const updated = await refresh();
      if (!updated.success) setError(`The request was recorded, but the request list could not refresh: ${updated.message}`);
      return true;
    } catch {
      setError("Could not reach the server. The supply request was not confirmed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submitRequest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const success = await postRequest({
      action: "request",
      warehouse: "supplies",
      note,
      lines: lines.map((line) => ({ item_id: line.item_id, quantity: Number(line.quantity) })),
    });
    if (success) {
      setLines([{ item_id: "", quantity: "" }]);
      setNote("");
    }
  }

  async function cancelRequest(requisitionId: string) {
    await postRequest({ action: "cancel", requisition_id: requisitionId });
  }

  function updateLine(index: number, key: keyof RequestLineDraft, value: string) {
    setLines((current) => current.map((line, lineIndex) =>
      lineIndex === index ? { ...line, [key]: value } : line
    ));
  }

  return (
    <DashboardShell>
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="border-b border-neutral-200 dark:border-neutral-800 pb-3">
          <h1 className="text-xl font-bold tracking-tight">Request from Central Store</h1>
          <p className="text-xs text-neutral-500 font-mono mt-0.5">
            Non-sale supplies • {activeOutlet?.name || "Select an outlet"} • requests and fulfillment are recorded
          </p>
        </div>

        {error && <div role="alert" className="px-3 py-2 text-xs border border-red-300 text-red-700 rounded">{error}</div>}
        {message && <div role="status" className="px-3 py-2 text-xs border border-neutral-200 dark:border-neutral-700 rounded">{message}</div>}
        {loading && <p className="text-xs text-neutral-500">Loading your supply requests…</p>}

        <section className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-4">
          <div className="flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-neutral-500" />
            <div>
              <h2 className="text-sm font-semibold">New supplies request</h2>
              <p className="text-xs text-neutral-500">Select items and quantities for this outlet. The stock controller records each issue from Central Store.</p>
            </div>
          </div>
          {supplies.length === 0 ? (
            <p className="text-xs text-neutral-500">No requestable supplies are configured yet. Ask a stock controller to add them to the property catalog.</p>
          ) : (
            <form onSubmit={submitRequest} className="space-y-3">
              <label className="block text-xs space-y-1">
                Note (optional)
                <input maxLength={500} value={note} onChange={(event) => setNote(event.target.value)}
                  placeholder="Reason or where these supplies are needed"
                  className="w-full p-2 border rounded bg-neutral-50 dark:bg-neutral-800" />
              </label>
              <div className="space-y-2">
                {lines.map((line, index) => (
                  <div key={index} className="grid grid-cols-[1fr_8rem_auto] gap-2">
                    <select required value={line.item_id}
                      onChange={(event) => updateLine(index, "item_id", event.target.value)}
                      className="p-2 text-xs border rounded bg-neutral-50 dark:bg-neutral-800">
                      <option value="">Select supply</option>
                      {supplies.map((supply) => (
                        <option key={supply.id} value={supply.id}>{supply.name} · {supply.sku} ({supply.unit})</option>
                      ))}
                    </select>
                    <input required type="number" min="0.001" step="0.001" value={line.quantity}
                      onChange={(event) => updateLine(index, "quantity", event.target.value)}
                      placeholder="Quantity"
                      className="p-2 text-xs border rounded bg-neutral-50 dark:bg-neutral-800" />
                    <button type="button" aria-label="Remove supply" disabled={lines.length <= 1}
                      onClick={() => setLines((current) => current.filter((_, lineIndex) => lineIndex !== index))}
                      className="p-2 border rounded disabled:opacity-30">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => setLines((current) => [...current, { item_id: "", quantity: "" }])}
                  className="flex items-center gap-1 px-2 py-1.5 border rounded text-xs">
                  <Plus className="w-3 h-3" /> Add supply
                </button>
                <button type="submit" disabled={busy || supplies.length === 0}
                  className="px-3 py-1.5 bg-black text-white dark:bg-white dark:text-black rounded text-xs font-semibold disabled:opacity-50">
                  {busy ? "Submitting…" : "Submit request"}
                </button>
              </div>
            </form>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-xs font-mono font-semibold uppercase tracking-wider text-neutral-500">My supply requests</h2>
          {requests.map((request) => {
            const active = request.status === "pending" || request.status === "partially_fulfilled";
            return (
              <article key={request.id} className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold">{request.outlet_name} · {new Date(request.created_at).toLocaleString()}</div>
                    <div className="text-[10px] text-neutral-500 font-mono">Request ID {request.id}</div>
                  </div>
                  <span className={`text-[10px] uppercase font-mono ${requestStatusClass(request.status)}`}>
                    {request.status.replace("_", " ")}
                  </span>
                </div>
                {request.note && <p className="text-xs text-neutral-500">{request.note}</p>}
                {request.rejection_reason && <p className="text-xs text-red-600">Reason: {request.rejection_reason}</p>}
                <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {request.lines.map((line) => (
                    <div key={line.item_id} className="flex flex-wrap justify-between gap-2 py-2 text-xs">
                      <span>{line.item_name}</span>
                      <span className="font-mono">
                        Issued {quantity(line.quantity_fulfilled)} / {quantity(line.quantity_requested)} {line.unit}
                      </span>
                    </div>
                  ))}
                </div>
                {request.resolved_by_name && (
                  <p className="text-[10px] text-neutral-500">
                    Last fulfilled by {request.resolved_by_name}{request.resolved_at ? ` · ${new Date(request.resolved_at).toLocaleString()}` : ""}
                  </p>
                )}
                {active && (
                  <button type="button" disabled={busy} onClick={() => void cancelRequest(request.id)}
                    className="px-2 py-1 border rounded text-xs disabled:opacity-50">
                    Cancel request
                  </button>
                )}
              </article>
            );
          })}
          {!loading && requests.length === 0 && (
            <div className="bg-white dark:bg-neutral-900 border border-dashed border-neutral-300 dark:border-neutral-700 rounded p-6 text-center text-xs text-neutral-500">
              You have not submitted any supply requests for this outlet.
            </div>
          )}
        </section>
      </div>
    </DashboardShell>
  );
}
