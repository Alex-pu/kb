"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { useTenantStore } from "@/lib/store/tenant-store";
import { Check, Loader2, Plus, RefreshCw, Sparkles, X } from "lucide-react";

type HousekeepingChecklist = Record<string, boolean>;

interface ChecklistItem {
  item_key: string;
  label: string;
  sort_order: number;
}

interface HousekeepingJob {
  id: string;
  room_id: string;
  room_number: string;
  floor: string;
  room_status: string;
  housekeeping_status: string;
  room_type_name: string;
  assigned_to: string | null;
  assignee_name: string | null;
  status: "pending" | "in_progress";
  checklist: HousekeepingChecklist;
  notes: string;
  created_at: string;
  updated_at: string;
}

interface HousekeepingStaff {
  id: string;
  full_name: string;
  role_name: string;
}

interface HousekeepingResponse {
  success: boolean;
  message?: string;
  jobs?: HousekeepingJob[];
  staff?: HousekeepingStaff[];
  checklist_items?: ChecklistItem[];
}

async function readResponse(response: Response): Promise<HousekeepingResponse> {
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || !("success" in value) || typeof value.success !== "boolean") {
    return { success: false, message: "The server returned an invalid housekeeping response." };
  }
  return value as HousekeepingResponse;
}

export default function HousekeepingPage() {
  const { activeProperty, currentUser, hasPermission } = useTenantStore();
  const canManage = hasPermission("housekeeping:manage");
  const [jobs, setJobs] = useState<HousekeepingJob[]>([]);
  const [staff, setStaff] = useState<HousekeepingStaff[]>([]);
  const [checklistItems, setChecklistItems] = useState<ChecklistItem[]>([]);
  const [checklistDraft, setChecklistDraft] = useState<ChecklistItem[]>([]);
  const [newChecklistLabel, setNewChecklistLabel] = useState("");
  const [editingChecklist, setEditingChecklist] = useState(false);
  const [savingChecklist, setSavingChecklist] = useState(false);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [notesDrafts, setNotesDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [savingJobId, setSavingJobId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loadTasks = useCallback(async () => {
    if (!activeProperty?.id) {
      setJobs([]);
      setStaff([]);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(`/api/housekeeping?property_id=${encodeURIComponent(activeProperty.id)}`, { credentials: "include" });
      const data = await readResponse(response);
      if (!response.ok || !data.success) {
        setMessage(data.message || "Housekeeping tasks could not be loaded.");
        return;
      }
      setJobs(data.jobs ?? []);
      setStaff(data.staff ?? []);
      setChecklistItems(data.checklist_items ?? []);
      if (!editingChecklist) setChecklistDraft(data.checklist_items ?? []);
      setNotesDrafts((current) => Object.fromEntries(
        (data.jobs ?? []).map((job) => [job.id, current[job.id] ?? job.notes]),
      ));
      setMessage(null);
    } catch {
      setMessage("Could not reach the server. Housekeeping tasks were not loaded.");
    } finally {
      setLoading(false);
    }
  }, [activeProperty?.id, editingChecklist]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    if (!activeProperty?.id) return;
    const interval = window.setInterval(() => void loadTasks(), 15000);
    return () => window.clearInterval(interval);
  }, [activeProperty?.id, loadTasks]);

  const summary = useMemo(() => ({
    queued: jobs.filter((job) => job.status === "pending").length,
    cleaning: jobs.filter((job) => job.status === "in_progress").length,
    unassigned: jobs.filter((job) => !job.assigned_to).length,
  }), [jobs]);

  const performAction = async (
    jobId: string,
    action: "assign" | "start" | "checklist" | "notes" | "ready",
    fields: Record<string, unknown> = {},
  ) => {
    if (!activeProperty?.id || savingJobId) return;
    setSavingJobId(jobId);
    try {
      const response = await fetch("/api/housekeeping", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ property_id: activeProperty.id, job_id: jobId, action, ...fields }),
      });
      const data = await readResponse(response);
      setMessage(data.message || (data.success ? "Housekeeping task updated." : "Housekeeping task was not updated."));
      if (response.ok && data.success) await loadTasks();
    } catch {
      setMessage("Could not reach the server. The housekeeping task was not confirmed.");
    } finally {
      setSavingJobId(null);
    }
  };

  const saveChecklist = async () => {
    if (!activeProperty?.id || savingChecklist || checklistDraft.length === 0) return;
    setSavingChecklist(true);
    try {
      const response = await fetch("/api/housekeeping", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          property_id: activeProperty.id,
          action: "save_checklist_template",
          checklist_items: checklistDraft.map(({ item_key, label }) => ({ item_key, label: label.trim() })),
        }),
      });
      const data = await readResponse(response);
      setMessage(data.message || (data.success ? "Room checklist saved." : "Room checklist was not saved."));
      if (response.ok && data.success) {
        setEditingChecklist(false);
        await loadTasks();
      }
    } catch {
      setMessage("Could not reach the server. The room checklist was not saved.");
    } finally {
      setSavingChecklist(false);
    }
  };

  return (
    <DashboardShell>
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 dark:border-neutral-800 pb-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight flex items-center gap-2"><Sparkles className="h-5 w-5" /> Housekeeping</h1>
            <p className="mt-1 text-xs text-neutral-500">Room assignments, cleaning work, and readiness checks · {activeProperty?.name || "No property selected"}</p>
          </div>
          <button type="button" onClick={() => void loadTasks()} disabled={loading} className="inline-flex items-center gap-2 rounded border border-neutral-300 px-3 py-2 text-xs font-semibold disabled:opacity-50 dark:border-neutral-700">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </button>
        </header>

        {message && <div role="status" className="rounded border border-neutral-200 bg-neutral-50 p-3 text-xs dark:border-neutral-700 dark:bg-neutral-900">{message}</div>}

        <div className="grid grid-cols-3 gap-3">
          {[
            ["Needs assignment", summary.unassigned],
            ["Waiting to start", summary.queued],
            ["In progress", summary.cleaning],
          ].map(([label, count]) => (
            <div key={label} className="rounded border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
              <div className="text-[10px] font-mono uppercase tracking-wider text-neutral-500">{label}</div>
              <div className="mt-1 text-xl font-semibold">{count}</div>
            </div>
          ))}
        </div>

        <section className="rounded border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">Room-readiness checklist</h2>
              <p className="mt-1 text-xs text-neutral-500">{checklistItems.length} required {checklistItems.length === 1 ? "check" : "checks"} for each room</p>
            </div>
            {canManage && !editingChecklist && (
              <button type="button" onClick={() => { setChecklistDraft(checklistItems); setEditingChecklist(true); }} className="rounded border border-neutral-300 px-3 py-2 text-xs font-semibold dark:border-neutral-700">
                Edit checklist
              </button>
            )}
          </div>
          {editingChecklist ? (
            <div className="mt-3 space-y-2">
              {checklistDraft.map((item, index) => (
                <div key={item.item_key} className="flex items-center gap-2">
                  <input
                    aria-label={`Checklist item ${index + 1}`}
                    maxLength={160}
                    value={item.label}
                    onChange={(event) => setChecklistDraft((current) => current.map((entry) => entry.item_key === item.item_key ? { ...entry, label: event.target.value } : entry))}
                    className="min-w-0 flex-1 rounded border border-neutral-200 bg-neutral-50 px-2 py-2 text-xs dark:border-neutral-700 dark:bg-neutral-800"
                  />
                  <button type="button" title="Remove checklist item" aria-label={`Remove ${item.label}`} onClick={() => setChecklistDraft((current) => current.filter((entry) => entry.item_key !== item.item_key))} className="rounded border border-neutral-200 p-2 dark:border-neutral-700">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <form className="flex flex-wrap gap-2" onSubmit={(event) => {
                event.preventDefault();
                const label = newChecklistLabel.trim();
                if (!label || checklistDraft.length >= 30) return;
                setChecklistDraft((current) => [...current, { item_key: crypto.randomUUID(), label, sort_order: current.length }]);
                setNewChecklistLabel("");
              }}>
                <input
                  aria-label="New checklist item"
                  maxLength={160}
                  value={newChecklistLabel}
                  onChange={(event) => setNewChecklistLabel(event.target.value)}
                  placeholder="Add a room check"
                  className="min-w-0 flex-1 rounded border border-neutral-200 bg-neutral-50 px-2 py-2 text-xs dark:border-neutral-700 dark:bg-neutral-800"
                />
                <button type="submit" disabled={!newChecklistLabel.trim() || checklistDraft.length >= 30} className="inline-flex items-center gap-1 rounded border border-neutral-300 px-3 py-2 text-xs font-semibold disabled:opacity-40 dark:border-neutral-700">
                  <Plus className="h-3.5 w-3.5" /> Add item
                </button>
              </form>
              <div className="flex flex-wrap justify-end gap-2 pt-2">
                <button type="button" disabled={savingChecklist} onClick={() => { setChecklistDraft(checklistItems); setEditingChecklist(false); }} className="rounded border border-neutral-300 px-3 py-2 text-xs font-semibold disabled:opacity-40 dark:border-neutral-700">Cancel</button>
                <button type="button" disabled={savingChecklist || checklistDraft.length === 0 || checklistDraft.some((item) => !item.label.trim())} onClick={() => void saveChecklist()} className="rounded bg-black px-3 py-2 text-xs font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-black">
                  {savingChecklist ? "Saving…" : "Save checklist"}
                </button>
              </div>
            </div>
          ) : (
            <ul className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
              {checklistItems.map((item) => <li key={item.item_key} className="flex items-start gap-2"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />{item.label}</li>)}
            </ul>
          )}
        </section>

        {jobs.length === 0 && !loading ? (
          <div className="rounded border border-neutral-200 bg-white p-8 text-center dark:border-neutral-800 dark:bg-neutral-900">
            <Check className="mx-auto h-6 w-6 text-emerald-600" />
            <h2 className="mt-2 text-sm font-semibold">No rooms waiting for housekeeping</h2>
            <p className="mt-1 text-xs text-neutral-500">Checked-out rooms and newly added rooms will appear here when cleaning is required.</p>
          </div>
        ) : (
          <section className="space-y-3">
            {jobs.map((job) => {
              const completedChecks = checklistItems.filter((item) => job.checklist[item.item_key]).length;
              const canEdit = canManage || job.assigned_to === currentUser?.id;
              const saving = savingJobId === job.id;
              return (
                <article key={job.id} className="rounded border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-semibold">Room {job.room_number} <span className="font-normal text-neutral-500">· {job.room_type_name}</span></h2>
                      <p className="mt-1 text-[10px] text-neutral-500">Floor {job.floor} · {job.status === "pending" ? "Waiting to start" : "Cleaning in progress"} · Checklist {completedChecks}/{checklistItems.length}</p>
                    </div>
                    <span className={`rounded px-2 py-1 text-[10px] font-mono uppercase ${job.status === "in_progress" ? "bg-orange-100 text-orange-800 dark:bg-orange-950/40 dark:text-orange-300" : "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"}`}>
                      {job.status.replace("_", " ")}
                    </span>
                  </div>

                  {canManage && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <select
                        aria-label={`Assign room ${job.room_number} to housekeeping staff`}
                        value={assignments[job.id] ?? job.assigned_to ?? ""}
                        onChange={(event) => setAssignments((current) => ({ ...current, [job.id]: event.target.value }))}
                        className="min-w-48 flex-1 rounded border border-neutral-200 bg-neutral-50 px-2 py-2 text-xs dark:border-neutral-700 dark:bg-neutral-800"
                      >
                        <option value="">Unassigned</option>
                        {staff.map((person) => <option key={person.id} value={person.id}>{person.full_name} · {person.role_name}</option>)}
                      </select>
                      <button
                        type="button"
                        disabled={saving || !(assignments[job.id] ?? job.assigned_to)}
                        onClick={() => void performAction(job.id, "assign", { staff_id: assignments[job.id] ?? job.assigned_to })}
                        className="rounded border border-neutral-300 px-3 py-2 text-xs font-semibold disabled:opacity-40 dark:border-neutral-700"
                      >
                        Assign
                      </button>
                    </div>
                  )}
                  <p className="mt-2 text-[10px] text-neutral-500">
                    {job.assignee_name ? `Assigned to ${job.assignee_name}` : "Not assigned"}
                  </p>

                  {job.status === "pending" ? (
                    <button
                      type="button"
                      disabled={saving || (!canManage && job.assigned_to !== currentUser?.id)}
                      onClick={() => void performAction(job.id, "start")}
                      className="mt-3 rounded bg-black px-3 py-2 text-xs font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-black"
                    >
                      {saving ? "Saving…" : "Start cleaning"}
                    </button>
                  ) : (
                    <div className="mt-4 grid gap-4 md:grid-cols-2">
                      <fieldset disabled={!canEdit || saving} className="space-y-2">
                        <legend className="mb-2 text-[10px] font-mono font-semibold uppercase tracking-wider text-neutral-500">Required room-readiness checklist</legend>
                        {checklistItems.map((item) => (
                          <label key={item.item_key} className="flex items-start gap-2 rounded border border-neutral-100 p-2 text-xs dark:border-neutral-800">
                            <input
                              type="checkbox"
                              checked={Boolean(job.checklist[item.item_key])}
                              onChange={(event) => void performAction(job.id, "checklist", {
                                checklist: { ...job.checklist, [item.item_key]: event.target.checked },
                              })}
                              className="mt-0.5"
                            />
                            <span>{item.label}</span>
                          </label>
                        ))}
                      </fieldset>
                      <div className="space-y-2">
                        <label className="block space-y-1 text-[10px] font-mono font-semibold uppercase tracking-wider text-neutral-500">
                          Room condition notes for Front Desk
                          <textarea
                            maxLength={1000}
                            rows={5}
                            disabled={!canEdit || saving}
                            value={notesDrafts[job.id] ?? job.notes}
                            onChange={(event) => setNotesDrafts((current) => ({ ...current, [job.id]: event.target.value }))}
                            onBlur={() => {
                              const notes = notesDrafts[job.id] ?? job.notes;
                              if (notes !== job.notes) void performAction(job.id, "notes", { notes });
                            }}
                            placeholder="Record room condition or anything the booking team should know."
                            className="w-full rounded border border-neutral-200 bg-neutral-50 p-2 text-xs font-normal normal-case dark:border-neutral-700 dark:bg-neutral-800"
                          />
                        </label>
                        <button
                          type="button"
                          disabled={saving || !checklistItems.every((item) => job.checklist[item.item_key]) || (!canManage && job.assigned_to !== currentUser?.id)}
                          onClick={() => void performAction(job.id, "ready")}
                          className="w-full rounded bg-emerald-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40"
                        >
                          {saving ? "Saving…" : "Complete checks and mark room ready"}
                        </button>
                        {!checklistItems.every((item) => job.checklist[item.item_key]) && <p className="text-[10px] text-neutral-500">All checks must pass before the room can be made available to Front Desk.</p>}
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </section>
        )}
      </div>
    </DashboardShell>
  );
}
