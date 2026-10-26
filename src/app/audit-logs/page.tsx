"use client";

import React, { useEffect, useState } from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { useTenantStore } from "@/lib/store/tenant-store";
import { formatDateTime } from "@/lib/utils";
import { Loader2 } from "lucide-react";

interface AuditLogEntry {
  id: string;
  property_id: string | null;
  action_type: string;
  resource_type: string;
  resource_id: string | null;
  payload_after: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
  actor_name: string;
}

export default function AuditLogsPage() {
  const { activeProperty } = useTenantStore();
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = activeProperty?.id ? `?property_id=${activeProperty.id}` : "";
    fetch(`/api/audit-logs${params}`, { credentials: "include" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (!data.success) {
          setError(data.message || "Could not load the audit trail.");
          setLogs([]);
          return;
        }
        setError(null);
        setLogs(data.logs ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("Could not reach the server.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProperty?.id]);

  return (
    <DashboardShell>
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-neutral-200 dark:border-neutral-800 pb-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100">
              Immutable Activity & Audit Trail
            </h1>
            <p className="text-xs text-neutral-500 font-mono mt-0.5">
              Principle 5: Every operational action is traceable (Actor, Station, Payload, Timestamp)
            </p>
          </div>
          <span className="text-xs font-mono px-2.5 py-1 bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 rounded">
            Append-Only Log
          </span>
        </div>

        {error && (
          <div className="p-2.5 bg-neutral-100 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 text-xs font-mono text-neutral-800 dark:text-neutral-200 rounded">
            {error}
          </div>
        )}

        {/* Audit Logs Table */}
        {loading ? (
          <div className="flex items-center justify-center py-12 text-neutral-400">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : (
          <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/60 font-mono text-neutral-500 text-[11px] uppercase">
                    <th className="py-2.5 px-4 font-semibold">Timestamp</th>
                    <th className="py-2.5 px-4 font-semibold">Actor / User</th>
                    <th className="py-2.5 px-4 font-semibold">Action Type</th>
                    <th className="py-2.5 px-4 font-semibold">Resource</th>
                    <th className="py-2.5 px-4 font-semibold">Payload Snapshot</th>
                    <th className="py-2.5 px-4 font-semibold">IP Address</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800 font-mono">
                  {logs.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-neutral-400">No audit events recorded yet.</td>
                    </tr>
                  ) : logs.map((log) => (
                    <tr key={log.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-800/30 transition-colors">
                      <td className="py-3 px-4 text-neutral-500 text-[11px] whitespace-nowrap">
                        {formatDateTime(log.created_at)}
                      </td>
                      <td className="py-3 px-4 font-sans font-semibold text-neutral-900 dark:text-neutral-100">
                        {log.actor_name}
                      </td>
                      <td className="py-3 px-4">
                        <span className="px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-200 font-semibold text-[10px]">
                          {log.action_type}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-neutral-600 dark:text-neutral-400">
                        {log.resource_type}
                      </td>
                      <td className="py-3 px-4 text-[10px] text-neutral-500 max-w-xs truncate">
                        {JSON.stringify(log.payload_after || {})}
                      </td>
                      <td className="py-3 px-4 text-neutral-400 text-[11px]">
                        {log.ip_address || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </DashboardShell>
  );
}
