"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { useTenantStore } from "@/lib/store/tenant-store";
import { Check, Loader2, Pencil, Plus, Printer, Save, UserRound, Wallet } from "lucide-react";

interface PayrollEmployee {
  id: string;
  employee_code: string | null;
  full_name: string;
  department: string;
  phone: string | null;
  daily_rate: number;
  status: "active" | "inactive";
  notes: string | null;
}

interface PayrollFolio {
  id: string;
  folio_number: number;
  week_start: string;
  week_end: string;
  prepared_by: string | null;
  checked_by: string | null;
  approved_by: string | null;
}

interface PayrollEntry {
  id?: string;
  employee_id: string;
  employee_code: string | null;
  employee_name: string;
  department: string;
  phone: string | null;
  work_days: string[];
  daily_rate: number;
  deductions: number;
  amount_paid: number;
  gross_pay?: number;
  net_pay?: number;
  balance_owed?: number;
  payment_status?: string;
  signature: string | null;
  notes: string | null;
}

interface PayrollResponse {
  success: boolean;
  message?: string;
  employees?: PayrollEmployee[];
  folios?: PayrollFolio[];
  folio?: PayrollFolio | null;
  entries?: PayrollEntry[];
}

interface EmployeeForm {
  employee_code: string;
  full_name: string;
  department: string;
  phone: string;
  daily_rate: string;
  status: "active" | "inactive";
  notes: string;
}

const EMPTY_EMPLOYEE: EmployeeForm = {
  employee_code: "",
  full_name: "",
  department: "",
  phone: "",
  daily_rate: "",
  status: "active",
  notes: "",
};

function localDateString(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function currentSunday() {
  const date = new Date();
  date.setDate(date.getDate() - date.getDay());
  return localDateString(date);
}

function datesForWeek(start: string) {
  const first = new Date(`${start}T12:00:00.000Z`);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(first);
    date.setUTCDate(date.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-KE", {
    style: "currency",
    currency: "KES",
    maximumFractionDigits: 2,
  }).format(value);
}

function moneyInput(value: number) {
  return value === 0 ? "" : String(value);
}

function calculateEntry(entry: PayrollEntry) {
  const gross = entry.work_days.length * entry.daily_rate;
  const net = gross - entry.deductions;
  const balance = Math.max(0, net - entry.amount_paid);
  const status = balance === 0 ? "PAID" : entry.amount_paid > 0 ? "PART PAID" : "UNPAID";
  return { gross, net, balance, status };
}

function toEntryDraft(entry: PayrollEntry): PayrollEntry {
  return {
    ...entry,
    work_days: entry.work_days ?? [],
    deductions: Number(entry.deductions),
    amount_paid: Number(entry.amount_paid),
    daily_rate: Number(entry.daily_rate),
    signature: entry.signature ?? null,
    notes: entry.notes ?? null,
  };
}

async function readResponse(response: Response): Promise<PayrollResponse> {
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null ||
      !("success" in value) || typeof value.success !== "boolean") {
    return { success: false, message: "The server returned an invalid casual payroll response." };
  }
  return value as PayrollResponse;
}

export default function CasualPayrollPage() {
  const { activeProperty, hasPermission } = useTenantStore();
  const canManage = hasPermission("payroll:manage");
  const [tab, setTab] = useState<"weekly" | "workers">("weekly");
  const [employees, setEmployees] = useState<PayrollEmployee[]>([]);
  const [folios, setFolios] = useState<PayrollFolio[]>([]);
  const [folio, setFolio] = useState<PayrollFolio | null>(null);
  const [entries, setEntries] = useState<PayrollEntry[]>([]);
  const [approvals, setApprovals] = useState({ prepared_by: "", checked_by: "", approved_by: "" });
  const [weekStart, setWeekStart] = useState(currentSunday);
  const [workerToAdd, setWorkerToAdd] = useState("");
  const [employeeDraft, setEmployeeDraft] = useState<EmployeeForm>(EMPTY_EMPLOYEE);
  const [editingEmployeeId, setEditingEmployeeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const loadWorkspace = useCallback(async () => {
    if (!activeProperty?.id) {
      setEmployees([]);
      setFolios([]);
      setFolio(null);
      setEntries([]);
      return;
    }
    setLoading(true);
    try {
      const query = new URLSearchParams({
        property_id: activeProperty.id,
        week_start: weekStart,
      });
      const response = await fetch(`/api/casual-payroll?${query}`, { credentials: "include" });
      const result = await readResponse(response);
      if (!response.ok || !result.success) {
        setMessage(result.message || "Casual payroll could not be loaded.");
        return;
      }
      setEmployees(result.employees ?? []);
      setFolios(result.folios ?? []);
      setFolio(result.folio ?? null);
      setEntries((result.entries ?? []).map(toEntryDraft));
      setApprovals({
        prepared_by: result.folio?.prepared_by ?? "",
        checked_by: result.folio?.checked_by ?? "",
        approved_by: result.folio?.approved_by ?? "",
      });
      setWorkerToAdd("");
      setMessage(null);
    } catch {
      setMessage("Could not reach the server. Casual payroll was not loaded.");
    } finally {
      setLoading(false);
    }
  }, [activeProperty?.id, weekStart]);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  const weekDays = useMemo(() => datesForWeek(weekStart), [weekStart]);
  const activeEmployees = useMemo(
    () => employees.filter((employee) => employee.status === "active"),
    [employees]
  );
  const availableWorkers = activeEmployees.filter(
    (employee) => !entries.some((entry) => entry.employee_id === employee.id)
  );
  const departmentTotals = useMemo(() => {
    const totals = new Map<string, { count: number; gross: number; deductions: number; net: number; paid: number; balance: number }>();
    for (const entry of entries) {
      const values = calculateEntry(entry);
      const total = totals.get(entry.department) ?? { count: 0, gross: 0, deductions: 0, net: 0, paid: 0, balance: 0 };
      total.count += 1;
      total.gross += values.gross;
      total.deductions += entry.deductions;
      total.net += values.net;
      total.paid += entry.amount_paid;
      total.balance += values.balance;
      totals.set(entry.department, total);
    }
    return Array.from(totals.entries()).sort(([left], [right]) => left.localeCompare(right));
  }, [entries]);
  const grandTotals = departmentTotals.reduce(
    (total, [, values]) => ({
      count: total.count + values.count,
      gross: total.gross + values.gross,
      deductions: total.deductions + values.deductions,
      net: total.net + values.net,
      paid: total.paid + values.paid,
      balance: total.balance + values.balance,
    }),
    { count: 0, gross: 0, deductions: 0, net: 0, paid: 0, balance: 0 }
  );

  async function sendMutation(body: Record<string, unknown>, method: "POST" | "PATCH") {
    const response = await fetch("/api/casual-payroll", {
      method,
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    const result = await readResponse(response);
    return { response, result };
  }

  async function openFolio() {
    if (!activeProperty?.id) return;
    setSaving(true);
    try {
      const { response, result } = await sendMutation({
        action: "create_folio",
        property_id: activeProperty.id,
        week_start: weekStart,
      }, "POST");
      if (!response.ok || !result.success) {
        setMessage(result.message || "The weekly folio could not be opened.");
        return;
      }
      setMessage(result.message || "Weekly folio opened.");
      await loadWorkspace();
    } catch {
      setMessage("Could not reach the server. The weekly folio was not opened.");
    } finally {
      setSaving(false);
    }
  }

  function addWorker() {
    const employee = activeEmployees.find((candidate) => candidate.id === workerToAdd);
    if (!employee || entries.some((entry) => entry.employee_id === employee.id)) return;
    setEntries((current) => [...current, {
      employee_id: employee.id,
      employee_code: employee.employee_code,
      employee_name: employee.full_name,
      department: employee.department,
      phone: employee.phone,
      work_days: [],
      daily_rate: employee.daily_rate,
      deductions: 0,
      amount_paid: 0,
      signature: null,
      notes: null,
    }].sort((left, right) =>
      left.department.localeCompare(right.department) || left.employee_name.localeCompare(right.employee_name)
    ));
    setWorkerToAdd("");
  }

  function updateEntry(employeeId: string, updates: Partial<PayrollEntry>) {
    setEntries((current) => current.map((entry) =>
      entry.employee_id === employeeId ? { ...entry, ...updates } : entry
    ));
  }

  async function saveFolio() {
    if (!activeProperty?.id || !folio) return;
    setSaving(true);
    try {
      const { response, result } = await sendMutation({
        action: "save_folio",
        property_id: activeProperty.id,
        folio_id: folio.id,
        prepared_by: approvals.prepared_by,
        checked_by: approvals.checked_by,
        approved_by: approvals.approved_by,
        entries: entries.map((entry) => ({
          employee_id: entry.employee_id,
          work_days: entry.work_days,
          deductions: entry.deductions,
          amount_paid: entry.amount_paid,
          signature: entry.signature,
          notes: entry.notes,
        })),
      }, "PATCH");
      if (!response.ok || !result.success) {
        setMessage(result.message || "The weekly folio could not be saved.");
        return;
      }
      setEntries((result.entries ?? []).map(toEntryDraft));
      setMessage(result.message || "Weekly folio saved.");
      await loadWorkspace();
    } catch {
      setMessage("Could not reach the server. The weekly folio was not saved.");
    } finally {
      setSaving(false);
    }
  }

  function startEmployeeEdit(employee: PayrollEmployee) {
    setEditingEmployeeId(employee.id);
    setEmployeeDraft({
      employee_code: employee.employee_code ?? "",
      full_name: employee.full_name,
      department: employee.department,
      phone: employee.phone ?? "",
      daily_rate: String(employee.daily_rate),
      status: employee.status,
      notes: employee.notes ?? "",
    });
    setMessage(null);
  }

  function resetEmployeeForm() {
    setEditingEmployeeId(null);
    setEmployeeDraft(EMPTY_EMPLOYEE);
  }

  async function saveEmployee(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeProperty?.id) return;
    const dailyRate = Number(employeeDraft.daily_rate);
    if (!Number.isFinite(dailyRate) || dailyRate <= 0) {
      setMessage("Enter a daily rate greater than zero.");
      return;
    }
    setSaving(true);
    try {
      const { response, result } = await sendMutation({
        action: editingEmployeeId ? "update_employee" : "create_employee",
        property_id: activeProperty.id,
        employee_id: editingEmployeeId,
        ...employeeDraft,
        daily_rate: dailyRate,
      }, editingEmployeeId ? "PATCH" : "POST");
      if (!response.ok || !result.success) {
        setMessage(result.message || "Worker details could not be saved.");
        return;
      }
      resetEmployeeForm();
      setMessage(result.message || "Worker details saved.");
      await loadWorkspace();
    } catch {
      setMessage("Could not reach the server. Worker details were not saved.");
    } finally {
      setSaving(false);
    }
  }

  const weekStartIsSunday = new Date(`${weekStart}T00:00:00.000Z`).getUTCDay() === 0;
  const printFolio = () => window.print();

  return (
    <DashboardShell>
      <div className="casual-payroll-screen mx-auto max-w-[1500px] space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 pb-3 dark:border-neutral-800">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Casual Payroll</h1>
            <p className="mt-0.5 text-xs text-neutral-500">Worker register and weekly payment folios</p>
          </div>
          <span className="rounded border border-indigo-200 bg-indigo-50 px-2 py-1 text-[10px] font-mono text-indigo-700 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-300">
            ADMIN & ACCOUNTANT
          </span>
        </div>

        {message && (
          <div role="status" className="rounded border border-neutral-200 bg-white px-3 py-2 text-xs dark:border-neutral-700 dark:bg-neutral-900">
            {message}
          </div>
        )}

        <div className="flex gap-2 border-b border-neutral-200 pb-2 dark:border-neutral-800">
          <button type="button" onClick={() => setTab("weekly")} className={`flex items-center gap-2 rounded border px-3 py-2 text-xs ${tab === "weekly" ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-black" : "border-neutral-200 dark:border-neutral-700"}`}>
            <Wallet className="h-4 w-4" /> Weekly payments
          </button>
          <button type="button" onClick={() => setTab("workers")} className={`flex items-center gap-2 rounded border px-3 py-2 text-xs ${tab === "workers" ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-black" : "border-neutral-200 dark:border-neutral-700"}`}>
            <UserRound className="h-4 w-4" /> Worker register
          </button>
        </div>

        {tab === "weekly" && (
          <section className="space-y-4">
            <div className="flex flex-wrap items-end gap-3 rounded border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
              <label className="text-[10px] font-mono text-neutral-500">
                Week starting Sunday
                <input
                  type="date"
                  value={weekStart}
                  onChange={(event) => {
                    if (event.target.value) setWeekStart(event.target.value);
                  }}
                  className="mt-1 block rounded border border-neutral-300 bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-800"
                />
              </label>
              <label className="min-w-52 text-[10px] font-mono text-neutral-500">
                Recent folios
                <select
                  value={weekStart}
                  onChange={(event) => setWeekStart(event.target.value)}
                  className="mt-1 block w-full rounded border border-neutral-300 bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-800"
                >
                  <option value={weekStart}>{weekStart}</option>
                  {folios.filter((item) => item.week_start !== weekStart).map((item) => (
                    <option key={item.id} value={item.week_start}>
                      Folio {String(item.folio_number).padStart(4, "0")} · {item.week_start}
                    </option>
                  ))}
                </select>
              </label>
              {folio && <span className="rounded bg-neutral-100 px-2.5 py-2 text-xs font-mono dark:bg-neutral-800">Folio {String(folio.folio_number).padStart(4, "0")}</span>}
              {folio && (
                <button
                  type="button"
                  onClick={printFolio}
                  className="inline-flex items-center gap-1.5 rounded border border-neutral-300 px-3 py-2 text-xs font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
                >
                  <Printer className="h-3.5 w-3.5" /> Print / Export PDF
                </button>
              )}
              {!folio && (
                <button
                  type="button"
                  disabled={saving || loading || !weekStartIsSunday || !canManage}
                  onClick={() => void openFolio()}
                  className="rounded bg-neutral-900 px-3 py-2 text-xs font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
                >
                  Open weekly folio
                </button>
              )}
              {loading && <Loader2 className="h-4 w-4 animate-spin text-neutral-400" aria-label="Loading payroll" />}
              {!weekStartIsSunday && <span className="text-xs text-rose-600">The weekly folio must start on a Sunday.</span>}
            </div>

            {folio ? (
              <>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
                  {[
                    ["Workers", String(grandTotals.count)],
                    ["Gross", formatMoney(grandTotals.gross)],
                    ["Deductions", formatMoney(grandTotals.deductions)],
                    ["Net pay", formatMoney(grandTotals.net)],
                    ["Amount paid", formatMoney(grandTotals.paid)],
                    ["Balance owed", formatMoney(grandTotals.balance)],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
                      <div className="text-[10px] font-mono uppercase text-neutral-500">{label}</div>
                      <div className="mt-1 text-sm font-semibold">{value}</div>
                    </div>
                  ))}
                </div>

                <div className="flex flex-wrap items-end gap-2 rounded border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
                  <label className="min-w-56 text-[10px] font-mono text-neutral-500">
                    Add active worker
                    <select
                      value={workerToAdd}
                      onChange={(event) => setWorkerToAdd(event.target.value)}
                      className="mt-1 block w-full rounded border border-neutral-300 bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-800"
                    >
                      <option value="">Select a worker</option>
                      {availableWorkers.map((employee) => (
                        <option key={employee.id} value={employee.id}>{employee.full_name} · {employee.department}</option>
                      ))}
                    </select>
                  </label>
                  <button type="button" disabled={!workerToAdd} onClick={addWorker} className="inline-flex items-center gap-1 rounded border border-neutral-300 px-3 py-2 text-xs disabled:opacity-50 dark:border-neutral-700">
                    <Plus className="h-3.5 w-3.5" /> Add worker
                  </button>
                  <span className="ml-auto text-[10px] text-neutral-500">Week: {folio.week_start} to {folio.week_end}</span>
                </div>

                <div className="overflow-x-auto rounded border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
                  <table className="w-full min-w-[1640px] border-collapse text-xs">
                    <thead className="bg-neutral-100 text-left text-[10px] uppercase text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                      <tr>
                        <th className="sticky left-0 z-10 bg-neutral-100 px-2 py-2 dark:bg-neutral-800">Worker / dept</th>
                        {weekDays.map((day) => (
                          <th key={day} className="px-1 py-2 text-center">
                            {new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en-KE", { weekday: "short", day: "numeric", timeZone: "UTC" })}
                          </th>
                        ))}
                        <th className="px-2 py-2 text-right">Days</th>
                        <th className="px-2 py-2 text-right">Rate</th>
                        <th className="px-2 py-2 text-right">Gross</th>
                        <th className="px-2 py-2 text-right">Deductions</th>
                        <th className="px-2 py-2 text-right">Net pay</th>
                        <th className="px-2 py-2 text-right">Paid</th>
                        <th className="px-2 py-2 text-right">Balance</th>
                        <th className="px-2 py-2">Status</th>
                        <th className="px-2 py-2">Signature</th>
                        <th className="px-2 py-2">Notes</th>
                        <th className="px-2 py-2">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map((entry) => {
                        const values = calculateEntry(entry);
                        return (
                          <tr key={entry.employee_id} className="border-t border-neutral-200 dark:border-neutral-800">
                            <td className="sticky left-0 z-10 min-w-44 bg-white px-2 py-2 dark:bg-neutral-900">
                              <div className="font-medium">{entry.employee_name}</div>
                              <div className="text-[10px] text-neutral-500">{entry.department}{entry.employee_code ? ` · ${entry.employee_code}` : ""}</div>
                              {entry.phone && <div className="text-[10px] text-neutral-500">{entry.phone}</div>}
                            </td>
                            {weekDays.map((day) => (
                              <td key={day} className="px-1 py-2 text-center">
                                <input
                                  type="checkbox"
                                  aria-label={`${entry.employee_name} worked ${day}`}
                                  checked={entry.work_days.includes(day)}
                                  onChange={(event) => updateEntry(entry.employee_id, {
                                    work_days: event.target.checked
                                      ? [...entry.work_days, day].sort()
                                      : entry.work_days.filter((workedDay) => workedDay !== day),
                                  })}
                                  className="h-4 w-4 accent-neutral-900"
                                />
                              </td>
                            ))}
                            <td className="px-2 py-2 text-right font-medium">{entry.work_days.length}</td>
                            <td className="px-2 py-2 text-right">{formatMoney(entry.daily_rate)}</td>
                            <td className="px-2 py-2 text-right">{formatMoney(values.gross)}</td>
                            <td className="px-2 py-2">
                              <input aria-label={`${entry.employee_name} deductions`} type="number" min="0" step="0.01" value={moneyInput(entry.deductions)} onChange={(event) => updateEntry(entry.employee_id, { deductions: Number(event.target.value) || 0 })} className="w-24 rounded border border-neutral-300 bg-neutral-50 p-1.5 text-right dark:border-neutral-700 dark:bg-neutral-800" />
                            </td>
                            <td className="px-2 py-2 text-right font-medium">{formatMoney(values.net)}</td>
                            <td className="px-2 py-2">
                              <input aria-label={`${entry.employee_name} amount paid`} type="number" min="0" step="0.01" value={moneyInput(entry.amount_paid)} onChange={(event) => updateEntry(entry.employee_id, { amount_paid: Number(event.target.value) || 0 })} className="w-24 rounded border border-neutral-300 bg-neutral-50 p-1.5 text-right dark:border-neutral-700 dark:bg-neutral-800" />
                            </td>
                            <td className="px-2 py-2 text-right">{formatMoney(values.balance)}</td>
                            <td className="px-2 py-2">
                              <span className={`rounded px-1.5 py-1 text-[9px] font-semibold ${values.status === "PAID" ? "bg-emerald-100 text-emerald-700" : values.status === "PART PAID" ? "bg-amber-100 text-amber-700" : "bg-rose-100 text-rose-700"}`}>{values.status}</span>
                            </td>
                            <td className="px-2 py-2">
                              <input aria-label={`${entry.employee_name} signature`} value={entry.signature ?? ""} onChange={(event) => updateEntry(entry.employee_id, { signature: event.target.value })} className="w-28 rounded border border-neutral-300 bg-neutral-50 p-1.5 dark:border-neutral-700 dark:bg-neutral-800" />
                            </td>
                            <td className="px-2 py-2">
                              <input aria-label={`${entry.employee_name} notes`} value={entry.notes ?? ""} onChange={(event) => updateEntry(entry.employee_id, { notes: event.target.value })} className="w-32 rounded border border-neutral-300 bg-neutral-50 p-1.5 dark:border-neutral-700 dark:bg-neutral-800" />
                            </td>
                            <td className="px-2 py-2">
                              <button type="button" onClick={() => setEntries((current) => current.filter((item) => item.employee_id !== entry.employee_id))} className="text-rose-600 hover:underline">Remove</button>
                            </td>
                          </tr>
                        );
                      })}
                      {entries.length === 0 && (
                        <tr><td colSpan={19} className="px-4 py-10 text-center text-neutral-500">No workers added to this weekly folio yet.</td></tr>
                      )}
                    </tbody>
                    {entries.length > 0 && (
                      <tfoot>
                        {departmentTotals.map(([department, totals]) => (
                          <tr key={department} className="border-t border-neutral-200 bg-neutral-50 text-[10px] font-semibold dark:border-neutral-800 dark:bg-neutral-800/50">
                            <td className="sticky left-0 bg-neutral-50 px-2 py-2 dark:bg-neutral-800"> {department} subtotal · {totals.count}</td>
                            <td colSpan={8} />
                            <td />
                            <td className="px-2 py-2 text-right">{formatMoney(totals.gross)}</td>
                            <td className="px-2 py-2 text-right">{formatMoney(totals.deductions)}</td>
                            <td className="px-2 py-2 text-right">{formatMoney(totals.net)}</td>
                            <td className="px-2 py-2 text-right">{formatMoney(totals.paid)}</td>
                            <td className="px-2 py-2 text-right">{formatMoney(totals.balance)}</td>
                            <td colSpan={4} />
                          </tr>
                        ))}
                        <tr className="border-t-2 border-neutral-400 bg-neutral-100 text-[10px] font-bold dark:border-neutral-600 dark:bg-neutral-800">
                          <td className="sticky left-0 bg-neutral-100 px-2 py-2 dark:bg-neutral-800">GRAND TOTAL · {grandTotals.count}</td>
                          <td colSpan={8} />
                          <td />
                          <td className="px-2 py-2 text-right">{formatMoney(grandTotals.gross)}</td>
                          <td className="px-2 py-2 text-right">{formatMoney(grandTotals.deductions)}</td>
                          <td className="px-2 py-2 text-right">{formatMoney(grandTotals.net)}</td>
                          <td className="px-2 py-2 text-right">{formatMoney(grandTotals.paid)}</td>
                          <td className="px-2 py-2 text-right">{formatMoney(grandTotals.balance)}</td>
                          <td colSpan={4} />
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>

                <div className="grid gap-3 rounded border border-neutral-200 bg-white p-3 sm:grid-cols-3 dark:border-neutral-800 dark:bg-neutral-900">
                  {([
                    ["prepared_by", "Prepared by"],
                    ["checked_by", "Checked by"],
                    ["approved_by", "Approved by"],
                  ] as const).map(([field, label]) => (
                    <label key={field} className="text-[10px] font-mono text-neutral-500">
                      {label}
                      <input
                        maxLength={200}
                        value={approvals[field]}
                        onChange={(event) => setApprovals({ ...approvals, [field]: event.target.value })}
                        className="mt-1 block w-full rounded border border-neutral-300 bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-800"
                      />
                    </label>
                  ))}
                </div>

                <div className="flex justify-end">
                  <button type="button" disabled={saving || loading || !canManage} onClick={() => void saveFolio()} className="inline-flex items-center gap-2 rounded bg-neutral-900 px-4 py-2.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black">
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    Save weekly folio
                  </button>
                </div>
              </>
            ) : (
              <div className="rounded border border-dashed border-neutral-300 bg-white px-4 py-10 text-center dark:border-neutral-700 dark:bg-neutral-900">
                <p className="text-sm font-medium">{weekStartIsSunday ? "No folio exists for this week." : "Select a Sunday to start a payroll week."}</p>
                <p className="mt-1 text-xs text-neutral-500">Opening a week creates a numbered folio. Past folios remain available in the week selector.</p>
              </div>
            )}
          </section>
        )}

        {tab === "workers" && (
          <section className="grid gap-5 xl:grid-cols-[minmax(300px,380px)_1fr]">
            <form onSubmit={(event) => void saveEmployee(event)} className="h-fit space-y-3 rounded border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">{editingEmployeeId ? "Edit worker" : "Add worker"}</h2>
                {editingEmployeeId && <button type="button" onClick={resetEmployeeForm} className="text-xs text-neutral-500 hover:underline">Cancel</button>}
              </div>
              <label className="block text-[10px] font-mono text-neutral-500">Full name
                <input required maxLength={200} value={employeeDraft.full_name} onChange={(event) => setEmployeeDraft({ ...employeeDraft, full_name: event.target.value })} className="mt-1 w-full rounded border border-neutral-300 bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-800" />
              </label>
              <label className="block text-[10px] font-mono text-neutral-500">Employee ID
                <input maxLength={100} value={employeeDraft.employee_code} onChange={(event) => setEmployeeDraft({ ...employeeDraft, employee_code: event.target.value })} className="mt-1 w-full rounded border border-neutral-300 bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-800" />
              </label>
              <label className="block text-[10px] font-mono text-neutral-500">Department
                <input required maxLength={100} value={employeeDraft.department} onChange={(event) => setEmployeeDraft({ ...employeeDraft, department: event.target.value })} placeholder="e.g. Housekeeping" className="mt-1 w-full rounded border border-neutral-300 bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-800" />
              </label>
              <label className="block text-[10px] font-mono text-neutral-500">Phone
                <input type="tel" maxLength={50} value={employeeDraft.phone} onChange={(event) => setEmployeeDraft({ ...employeeDraft, phone: event.target.value })} className="mt-1 w-full rounded border border-neutral-300 bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-800" />
              </label>
              <label className="block text-[10px] font-mono text-neutral-500">Standard daily rate (KES)
                <input required type="number" min="0.01" step="0.01" value={employeeDraft.daily_rate} onChange={(event) => setEmployeeDraft({ ...employeeDraft, daily_rate: event.target.value })} className="mt-1 w-full rounded border border-neutral-300 bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-800" />
              </label>
              <label className="block text-[10px] font-mono text-neutral-500">Status
                <select value={employeeDraft.status} onChange={(event) => setEmployeeDraft({ ...employeeDraft, status: event.target.value as EmployeeForm["status"] })} className="mt-1 w-full rounded border border-neutral-300 bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-800">
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </label>
              <label className="block text-[10px] font-mono text-neutral-500">Notes
                <textarea maxLength={2000} rows={3} value={employeeDraft.notes} onChange={(event) => setEmployeeDraft({ ...employeeDraft, notes: event.target.value })} className="mt-1 w-full rounded border border-neutral-300 bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-800" />
              </label>
              <button type="submit" disabled={saving || loading || !canManage} className="inline-flex w-full items-center justify-center gap-2 rounded bg-neutral-900 px-3 py-2.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : editingEmployeeId ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                {editingEmployeeId ? "Save worker" : "Add worker"}
              </button>
            </form>

            <div className="overflow-hidden rounded border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
              <div className="flex items-center justify-between border-b border-neutral-200 p-4 dark:border-neutral-800">
                <div><h2 className="text-sm font-semibold">Worker register</h2><p className="mt-1 text-[10px] text-neutral-500">{employees.length} worker{employees.length === 1 ? "" : "s"} · inactive workers stay in the register</p></div>
                {loading && <Loader2 className="h-4 w-4 animate-spin text-neutral-400" />}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[700px] text-left text-xs">
                  <thead className="bg-neutral-100 text-[10px] uppercase text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                    <tr><th className="px-3 py-2">Worker / ID</th><th className="px-3 py-2">Department</th><th className="px-3 py-2">Phone</th><th className="px-3 py-2 text-right">Daily rate</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Action</th></tr>
                  </thead>
                  <tbody>
                    {employees.map((employee) => (
                      <tr key={employee.id} className="border-t border-neutral-200 dark:border-neutral-800">
                        <td className="px-3 py-2"><div className="font-medium">{employee.full_name}</div><div className="text-[10px] text-neutral-500">{employee.employee_code || "No ID"}</div></td>
                        <td className="px-3 py-2">{employee.department}</td>
                        <td className="px-3 py-2">{employee.phone || "—"}</td>
                        <td className="px-3 py-2 text-right">{formatMoney(employee.daily_rate)}</td>
                        <td className="px-3 py-2"><span className={`rounded px-1.5 py-1 text-[9px] font-semibold ${employee.status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-neutral-200 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300"}`}>{employee.status.toUpperCase()}</span></td>
                        <td className="px-3 py-2"><button type="button" onClick={() => startEmployeeEdit(employee)} className="inline-flex items-center gap-1 text-indigo-700 hover:underline dark:text-indigo-300"><Pencil className="h-3.5 w-3.5" /> Edit</button></td>
                      </tr>
                    ))}
                    {employees.length === 0 && <tr><td colSpan={6} className="px-3 py-10 text-center text-neutral-500">No workers registered for this property yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}
      </div>
      {tab === "weekly" && folio && (
        <section className="casual-payroll-print-document" aria-label="Printable casual payroll folio">
          <header className="casual-payroll-print-header">
            <h1>CASUAL WORKERS — WEEKLY PAYMENT FOLIO</h1>
            <div className="casual-payroll-print-meta">
              <span><strong>Property:</strong> {activeProperty?.name ?? ""}</span>
              <span><strong>Folio No.:</strong> {String(folio.folio_number).padStart(4, "0")}</span>
              <span><strong>Period:</strong> {folio.week_start} to {folio.week_end}</span>
            </div>
          </header>
          <table className="casual-payroll-print-table">
            <thead>
              <tr>
                <th>Worker / Dept</th>
                {weekDays.map((day) => (
                  <th key={day}>{new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en-KE", { weekday: "short", day: "numeric", timeZone: "UTC" })}</th>
                ))}
                <th>Days</th>
                <th>Rate</th>
                <th>Gross</th>
                <th>Deduct.</th>
                <th>Net Pay</th>
                <th>Paid</th>
                <th>Balance</th>
                <th>Status</th>
                <th>Signature</th>
                <th>Notes</th>
              </tr>
            </thead>
            {departmentTotals.map(([department, totals]) => (
              <tbody key={department}>
                {entries.filter((entry) => entry.department === department).map((entry) => {
                  const values = calculateEntry(entry);
                  return (
                    <tr key={entry.employee_id}>
                      <td>
                        <strong>{entry.employee_name}</strong>
                        <br />{entry.employee_code || "—"} · {entry.department}
                        {entry.phone && <><br />{entry.phone}</>}
                      </td>
                      {weekDays.map((day) => (
                        <td key={day} className="casual-payroll-print-day">
                          {entry.work_days.includes(day) ? "X" : ""}
                        </td>
                      ))}
                      <td>{entry.work_days.length}</td>
                      <td>{formatMoney(entry.daily_rate)}</td>
                      <td>{formatMoney(values.gross)}</td>
                      <td>{formatMoney(entry.deductions)}</td>
                      <td>{formatMoney(values.net)}</td>
                      <td>{formatMoney(entry.amount_paid)}</td>
                      <td>{formatMoney(values.balance)}</td>
                      <td>{values.status}</td>
                      <td>{entry.signature || ""}</td>
                      <td>{entry.notes || ""}</td>
                    </tr>
                  );
                })}
                <tr className="casual-payroll-print-subtotal">
                  <th>{department} subtotal ({totals.count})</th>
                  <td colSpan={8} />
                  <th>{formatMoney(totals.gross)}</th>
                  <th>{formatMoney(totals.deductions)}</th>
                  <th>{formatMoney(totals.net)}</th>
                  <th>{formatMoney(totals.paid)}</th>
                  <th>{formatMoney(totals.balance)}</th>
                  <td colSpan={3} />
                </tr>
              </tbody>
            ))}
            <tfoot>
              <tr>
                <th>GRAND TOTAL ({grandTotals.count} workers)</th>
                <td colSpan={8} />
                <th>{formatMoney(grandTotals.gross)}</th>
                <th>{formatMoney(grandTotals.deductions)}</th>
                <th>{formatMoney(grandTotals.net)}</th>
                <th>{formatMoney(grandTotals.paid)}</th>
                <th>{formatMoney(grandTotals.balance)}</th>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
          <footer className="casual-payroll-print-approvals">
            <span>Prepared by: {folio.prepared_by || "________________________"}</span>
            <span>Checked by: {folio.checked_by || "________________________"}</span>
            <span>Approved by: {folio.approved_by || "________________________"}</span>
          </footer>
        </section>
      )}
    </DashboardShell>
  );
}
