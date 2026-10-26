"use client";

import React, { useEffect, useState } from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { useTenantStore } from "@/lib/store/tenant-store";
import { Kot, KotStatus, PrepStation } from "@/lib/types/database";
import { Beer, ChefHat, Clock, X } from "lucide-react";

const NEXT_STATUS: Partial<Record<KotStatus, { next: KotStatus; label: string }>> = {
  new: { next: "accepted", label: "Accept ticket" },
  accepted: { next: "preparing", label: "Start preparing" },
  preparing: { next: "ready", label: "Mark ready" },
  ready: { next: "served", label: "Mark served" },
};

const STATUS_STYLES: Record<KotStatus, string> = {
  new: "border-neutral-900 dark:border-white",
  accepted: "border-blue-400",
  preparing: "border-amber-400",
  ready: "border-emerald-500",
  served: "border-neutral-200 dark:border-neutral-800 opacity-50",
  cancelled: "border-red-300 opacity-50",
};

function useTicketAge(createdAt: string) {
  const [ageSeconds, setAgeSeconds] = useState(() => Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000));
  useEffect(() => {
    const interval = setInterval(() => setAgeSeconds(Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000)), 1000);
    return () => clearInterval(interval);
  }, [createdAt]);
  return ageSeconds;
}

function TicketCard({ kot, canManage, onTransition, onCancel }: { kot: Kot; canManage: boolean; onTransition: (id: string, next: KotStatus) => void; onCancel: (id: string) => void }) {
  const ageSeconds = useTicketAge(kot.created_at);
  const minutes = Math.floor(ageSeconds / 60);
  const seconds = ageSeconds % 60;
  const isAging = minutes >= 10;
  const action = NEXT_STATUS[kot.status];

  return (
    <div className={`border-2 rounded p-3 bg-white dark:bg-neutral-900 ${STATUS_STYLES[kot.status]}`}>
      <div className="flex items-center justify-between">
        <span className="font-bold text-sm">{kot.table_name} • Round {kot.round}</span>
        <span className={`flex items-center gap-1 text-[10px] font-mono ${isAging ? "text-red-600 font-bold" : "text-neutral-500"}`}>
          <Clock className="w-3 h-3" />{minutes}:{seconds.toString().padStart(2, "0")}
        </span>
      </div>
      <div className="mt-1 text-[10px] font-mono uppercase tracking-wide text-neutral-500">{kot.status}</div>
      <div className="mt-2 space-y-1">
        {kot.lines.map((line) => (
          <div key={line.item.id} className="space-y-1">
            <div className="flex justify-between text-xs">
              <span>{line.quantity} x {line.item.name}</span>
            </div>
            {line.instructions && (
              <p className="border-l-2 border-amber-400 pl-2 text-[11px] text-amber-700 dark:text-amber-300">
                Prep: {line.instructions}
              </p>
            )}
          </div>
        ))}
      </div>
      {kot.status === "cancelled" && kot.cancel_reason && (
        <div className="mt-2 text-[10px] font-mono text-red-600">Cancelled: {kot.cancel_reason}</div>
      )}
      {action && canManage && (
        <div className="mt-3 flex gap-2">
          <button onClick={() => onTransition(kot.id, action.next)} className="flex-1 py-2 bg-black text-white dark:bg-white dark:text-black rounded text-xs font-semibold">
            {action.label}
          </button>
          <button onClick={() => onCancel(kot.id)} className="px-2 border border-neutral-300 dark:border-neutral-700 rounded"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}
    </div>
  );
}

export default function KdsPage() {
  const { activeOutlet, kots, loadRestaurantKots, transitionKot, hasPermission } = useTenantStore();
  const canManage = hasPermission("kds:manage");
  const [stationFilter, setStationFilter] = useState<"all" | PrepStation>("all");
  const [message, setMessage] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  useEffect(() => {
    let cancelled = false;
    void loadRestaurantKots().then((result) => {
      if (!cancelled) setMessage(result.success ? null : result.message);
    });
    return () => { cancelled = true; };
  }, [activeOutlet?.id, loadRestaurantKots]);

  const visibleKots = kots
    .filter((kot) => kot.status !== "served" && kot.status !== "cancelled")
    .filter((kot) => stationFilter === "all" || kot.station === stationFilter)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  const handleTransition = async (id: string, next: KotStatus) => {
    const result = await transitionKot(id, next);
    setMessage(result.message);
  };

  const submitCancel = async () => {
    if (!cancelTarget) return;
    const result = await transitionKot(cancelTarget, "cancelled", cancelReason);
    setMessage(result.message);
    if (result.success) {
      setCancelTarget(null);
      setCancelReason("");
    }
  };

  return (
    <DashboardShell>
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800 pb-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Kitchen Display System</h1>
            <p className="text-xs text-neutral-500 font-mono mt-0.5">Phase 3 • Delta KOTs, station routing, ticket state machine</p>
          </div>
          <div className="flex gap-1">
            {([["all", "All", null], ["kitchen", "Kitchen", ChefHat], ["bar", "Bar", Beer]] as const).map(([key, label, Icon]) => (
              <button key={key} onClick={() => setStationFilter(key)} className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border ${stationFilter === key ? "bg-black text-white dark:bg-white dark:text-black border-black dark:border-white" : "border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300"}`}>
                {Icon && <Icon className="w-3.5 h-3.5" />}{label}
              </button>
            ))}
          </div>
        </div>

        {message && <div role="status" className="px-3 py-2 text-xs font-mono bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded">{message}</div>}

        {visibleKots.length === 0 ? (
          <div className="text-xs font-mono text-neutral-400 py-16 text-center">No active tickets</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {visibleKots.map((kot) => (
            <TicketCard key={kot.id} kot={kot} canManage={canManage} onTransition={handleTransition} onCancel={setCancelTarget} />
            ))}
          </div>
        )}

        {cancelTarget && canManage && (
          <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
            <div className="w-full max-w-sm bg-white dark:bg-neutral-900 border border-neutral-300 dark:border-neutral-700 rounded p-5 space-y-3">
              <h2 className="font-semibold text-sm">Cancel ticket</h2>
              <p className="text-xs text-neutral-500">A reason is required for the audit trail.</p>
              <input autoFocus value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} placeholder="e.g. Guest changed order" className="w-full p-2 text-xs border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded" />
              <div className="flex gap-2">
                <button onClick={() => { setCancelTarget(null); setCancelReason(""); }} className="flex-1 py-2 border border-neutral-300 dark:border-neutral-700 rounded text-xs font-semibold">Back</button>
                <button onClick={submitCancel} disabled={!cancelReason.trim()} className="flex-1 py-2 bg-black text-white dark:bg-white dark:text-black rounded text-xs font-semibold disabled:opacity-30">Confirm cancel</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardShell>
  );
}
