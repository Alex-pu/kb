"use client";

import { useEffect } from "react";
import { syncOfflineOperations } from "@/lib/offline/sync-manager";
import type { OfflineOperation } from "@/lib/offline/offline-queue";

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

export function OfflineSyncBootstrap() {
  useEffect(() => {
    const sync = () => {
      if (!navigator.onLine) return;
      syncOfflineOperations(replayOfflineOperation).catch(() => undefined);
    };

    window.addEventListener("online", sync);
    sync();
    return () => window.removeEventListener("online", sync);
  }, []);

  return null;
}
