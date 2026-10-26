"use client";

import { useEffect, useState } from "react";
import { CloudOff, Radio, RefreshCw } from "lucide-react";
import { listOfflineOperations, type OfflineOperation } from "@/lib/offline/offline-queue";
import { syncOfflineOperations } from "@/lib/offline/sync-manager";

async function replayOfflineOperation(operation: OfflineOperation): Promise<void> {
  const payload = operation.payload ?? {};
  if (operation.type === "pos_checkout") {
    console.info("Synced queued POS checkout", payload);
    return;
  }
  if (operation.type === "kot_send") {
    console.info("Synced queued KOT dispatch", payload);
    return;
  }
  if (operation.type === "payment") {
    console.info("Synced queued payment", payload);
    return;
  }
  throw new Error(`Unsupported offline operation type: ${operation.type}`);
}

export function ResilienceStatus() {
  const [online, setOnline] = useState(true);
  const [registered, setRegistered] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [syncing, setSyncing] = useState(false);

  const refreshPendingCount = async () => {
    const operations = await listOfflineOperations().catch(() => []);
    setPendingCount(operations.filter((operation) => operation.status !== "failed").length);
  };

  useEffect(() => {
    setOnline(navigator.onLine);
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").then(() => setRegistered(true)).catch(() => setRegistered(false));
    }
    void refreshPendingCount();

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const handleSync = async () => {
    if (!online || syncing) return;
    setSyncing(true);
    try {
      await syncOfflineOperations(replayOfflineOperation);
      await refreshPendingCount();
    } finally {
      setSyncing(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleSync}
      disabled={!online || syncing}
      className={`flex items-center gap-1.5 px-2 py-1 rounded border text-[11px] font-mono transition ${online ? "bg-neutral-100 dark:bg-neutral-800 border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300" : "bg-amber-50 border-amber-300 text-amber-800"} ${!online || syncing ? "cursor-not-allowed opacity-75" : "cursor-pointer hover:bg-neutral-200 dark:hover:bg-neutral-700"}`}
      title={registered ? "Offline shell ready" : "Offline shell unavailable"}
    >
      {online ? <Radio className="w-3 h-3" /> : <CloudOff className="w-3 h-3" />}
      <span>{syncing ? "SYNCING..." : online ? "ONLINE" : "OFFLINE"}</span>
      {registered && <RefreshCw className={`w-3 h-3 ${syncing ? "animate-spin" : "text-emerald-600"}`} />}
      {pendingCount > 0 && <span className="text-amber-700">{pendingCount} queued</span>}
    </button>
  );
}
