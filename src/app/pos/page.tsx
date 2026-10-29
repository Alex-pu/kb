"use client";

import React, { useEffect, useMemo, useState } from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { useTenantStore } from "@/lib/store/tenant-store";
import { ProductCategory, ShiftPeriod, TenderType } from "@/lib/types/database";
import { businessDateForCountry } from "@/lib/utils/business-date";
import { Banknote, CreditCard, Loader2, Minus, Plus, Search, Smartphone, Trash2, WalletCards } from "lucide-react";

const categoryLabels: { key: "all" | ProductCategory; label: string }[] = [
  { key: "all", label: "All items" },
  { key: "grocery", label: "Grocery" },
  { key: "beverage", label: "Beverages" },
  { key: "household", label: "Household" },
  { key: "hardware", label: "Hardware" },
];

export default function PosPage() {
  const { catalog, cart, activeShift, currentUser, activeRole, lastReceipt, addToCart, updateCartQuantity, clearCart, checkout, loadShift, openShift, closeShift, clearReceipt, activeProperty, activeOutlet, activeStation, company, hasPermission } = useTenantStore();
  const canOpenShift = hasPermission("shift:open");
  const canCloseShift = hasPermission("shift:close");
  const canOperatePos = hasPermission("pos:write");
  const canClearRestaurantBills = hasPermission("restaurant:settle");
  const isRestaurantCashier = canClearRestaurantBills;
  const cashierRoleMissingPermission = !canClearRestaurantBills &&
    (activeRole?.role_key === "cashier" || activeRole?.name.toLowerCase().includes("cashier"));
  const canReadInventory = hasPermission("inventory:read");
  const today = businessDateForCountry(company?.country_code);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"all" | ProductCategory>("all");
  const [openingFloat, setOpeningFloat] = useState("0");
  const [shiftPeriod, setShiftPeriod] = useState<ShiftPeriod>("morning");
  const [shiftDate, setShiftDate] = useState(today);
  const [countedCash, setCountedCash] = useState("");
  const [closingShift, setClosingShift] = useState(false);
  const [tenders, setTenders] = useState<Record<TenderType, string>>({ cash: "", mpesa: "", card: "" });
  const [mpesaReference, setMpesaReference] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [billDate, setBillDate] = useState(today);
  const [billsLoading, setBillsLoading] = useState(false);
  const [billsMessage, setBillsMessage] = useState<string | null>(null);
  const [selectedBillId, setSelectedBillId] = useState<string | null>(null);
  const [customerPins, setCustomerPins] = useState<Record<string, string>>({});
  const [customerNames, setCustomerNames] = useState<Record<string, string>>({});
  const [submittingEtimsBillId, setSubmittingEtimsBillId] = useState<string | null>(null);
  const { restaurantBills, loadRestaurantBills, loadRestaurantChecks, settleTable } = useTenantStore();

  useEffect(() => {
    if (!activeOutlet) setMessage("Select an outlet to start trading.");
  }, [activeOutlet]);

  useEffect(() => {
    if (shiftDate !== today) setShiftDate(today);
  }, [shiftDate, today]);

  useEffect(() => {
    if (activeStation) void loadShift("pos");
  }, [activeStation, loadShift]);

  useEffect(() => {
    if (!isRestaurantCashier || !activeOutlet) return;
    void loadRestaurantChecks().then((result) => {
      if (!result.success) setBillsMessage(result.message);
    });
  }, [activeOutlet?.id, isRestaurantCashier, loadRestaurantChecks]);

  useEffect(() => {
    if (!isRestaurantCashier || !activeOutlet) return;
    let cancelled = false;
    setBillsLoading(true);
    void loadRestaurantBills(billDate).then((result) => {
      if (!cancelled) {
        setBillsMessage(result.success ? null : result.message);
        setBillsLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [activeOutlet?.id, billDate, isRestaurantCashier, loadRestaurantBills]);

  useEffect(() => {
    if (!isRestaurantCashier || !activeOutlet ||
        !restaurantBills.some((bill) => bill.etims_status === "pending")) return;
    const interval = window.setInterval(() => {
      void loadRestaurantBills(billDate).then((result) => {
        if (!result.success) setBillsMessage(result.message);
      });
    }, 10_000);
    return () => window.clearInterval(interval);
  }, [activeOutlet?.id, billDate, isRestaurantCashier, loadRestaurantBills, restaurantBills]);

  useEffect(() => {
    setCountedCash("");
  }, [activeShift?.id]);

  const visibleItems = useMemo(() => catalog.filter((item) => {
    const matchesQuery = `${item.name} ${item.sku} ${item.barcode || ""}`.toLowerCase().includes(query.toLowerCase());
    return item.item_type !== "supply" && item.is_active && matchesQuery &&
      (category === "all" || item.category === category);
  }), [catalog, category, query]);
  const total = cart.reduce((sum, line) => sum + line.item.price * line.quantity, 0);
  const tenderTotal = Object.values(tenders).reduce((sum, amount) => sum + Number(amount || 0), 0);

  const submitCloseShift = async () => {
    if (!activeShift || countedCash.trim() === "" || closingShift) return;
    setClosingShift(true);
    setMessage("Closing POS shift...");
    try {
      const result = await closeShift("pos", Number(countedCash));
      setMessage(result.message);
      if (result.success) setCountedCash("");
    } catch {
      setMessage("The POS shift could not be closed. Please retry or contact a manager.");
    } finally {
      setClosingShift(false);
    }
  };

  const submitCheckout = async () => {
    const result = await checkout((Object.entries(tenders) as [TenderType, string][])
      .filter(([, amount]) => Number(amount) > 0)
      .map(([type, amount]) => ({ type, amount: Number(amount), reference: type === "mpesa" ? mpesaReference : undefined })), `checkout-${Date.now()}`);
    setMessage(result.message);
    if (result.success) {
      setTenders({ cash: "", mpesa: "", card: "" });
      setMpesaReference("");
    }
  };

  const printRestaurantBill = (bill: (typeof restaurantBills)[number]) => {
    const printWindow = window.open("", "_blank", "width=420,height=720");
    if (!printWindow) {
      setBillsMessage("The bill could not be opened for printing. Allow pop-ups and try again.");
      return;
    }
    const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character] ?? character);
    const itemLines = bill.lines.map((line) =>
      `<div class="line"><span>${line.quantity} × ${escapeHtml(line.item.name)}</span><span>KSh ${(line.item.price * line.quantity).toFixed(2)}</span></div>`
    ).join("");
    const paymentLines = bill.payments.map((payment) =>
      `<div>${escapeHtml(payment.type.toUpperCase())}: KSh ${payment.amount.toFixed(2)}${payment.reference ? ` • ${escapeHtml(payment.reference)}` : ""}</div>`
    ).join("");
    printWindow.document.write(`<!doctype html><html><head><title>Restaurant bill ${escapeHtml(bill.bill_number)}</title><style>body{font:14px Arial,sans-serif;max-width:360px;margin:24px auto;color:#111}h1,p{margin:0 0 8px}.muted{color:#555;font-size:12px}.line{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px dashed #bbb}.total{display:flex;justify-content:space-between;margin-top:14px;padding-top:10px;border-top:2px solid #111;font-weight:bold}.payments{margin-top:12px;font-size:12px}</style></head><body><h1>KORE BENCH</h1><p>Restaurant bill • ${escapeHtml(bill.table_name)}</p><p class="muted">Bill: ${escapeHtml(bill.bill_number)}<br>Waiter: ${escapeHtml(bill.waiter_name)}<br>${escapeHtml(bill.business_date)} • ${new Date(bill.created_at).toLocaleString()}</p><p>${bill.room_charge_pending ? "Awaiting reception approval" : bill.status.toUpperCase()}</p>${itemLines}<div class="total"><span>Total</span><span>KSh ${bill.total.toFixed(2)}</span></div><div class="payments">${paymentLines}</div><script>window.onload=()=>window.print()</script></body></html>`);
    printWindow.document.close();
  };

  const printFiscalReceipt = (bill: (typeof restaurantBills)[number]) => {
    if (bill.etims_status !== "submitted" || !bill.etims_invoice_number || !bill.etims_signature || !bill.etims_verification_url) return;
    const printWindow = window.open("", "_blank", "width=420,height=720");
    if (!printWindow) {
      setBillsMessage("The fiscal receipt could not be opened for printing. Allow pop-ups and try again.");
      return;
    }
    const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character] ?? character);
    printWindow.document.write(`<!doctype html><html><head><title>DigiTax receipt ${escapeHtml(bill.bill_number)}</title><style>body{font:13px Arial,sans-serif;max-width:360px;margin:24px auto;color:#111}h1,p{margin:0 0 9px}.muted{color:#555;font-size:11px}.signature{overflow-wrap:anywhere;font-size:10px;border-top:1px dashed #777;padding-top:8px}</style></head><body><h1>eTIMS fiscal receipt</h1><p>${escapeHtml(bill.table_name)} • Bill ${escapeHtml(bill.bill_number)}</p><p>Total: KSh ${bill.total.toFixed(2)}</p><p class="muted">Invoice: ${escapeHtml(bill.etims_invoice_number)}<br>Receipt number: ${escapeHtml(bill.etims_receipt_number ?? "—")}<br>Receipt date: ${escapeHtml(bill.etims_receipt_date ?? "—")}<br>Customer: ${escapeHtml(bill.etims_customer_name ?? "—")}<br>Customer PIN: ${escapeHtml(bill.etims_customer_tin ?? "—")}</p><p>Verify: <a href="${escapeHtml(bill.etims_verification_url)}">${escapeHtml(bill.etims_verification_url)}</a></p><p class="signature">Signature: ${escapeHtml(bill.etims_signature)}</p><script>window.onload=()=>window.print()</script></body></html>`);
    printWindow.document.close();
  };

  const submitEtimsReceipt = async (bill: (typeof restaurantBills)[number]) => {
    if (!activeOutlet || submittingEtimsBillId) return;
    setBillsMessage(null);
    setSubmittingEtimsBillId(bill.id);
    try {
      const response = await fetch("/api/restaurant/etims", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          outlet_id: activeOutlet.id,
          check_id: bill.id,
          customer_pin: customerPins[bill.id]?.trim() || undefined,
          customer_name: customerNames[bill.id]?.trim() || undefined,
          ...(bill.etims_status === "blocked" || bill.etims_status === "failed" ? { action: "retry_blocked" } : {}),
        }),
      });
      const data = await response.json();
      setMessage(data.message || "eTIMS status could not be updated.");
      if (!response.ok || !data.success) {
        setBillsMessage(data.message || "eTIMS status could not be updated.");
        return;
      }
      setCustomerPins((current) => ({ ...current, [bill.id]: "" }));
      setCustomerNames((current) => ({ ...current, [bill.id]: "" }));
      const refreshed = await loadRestaurantBills(billDate);
      if (!refreshed.success) setBillsMessage(refreshed.message);
    } catch {
      setBillsMessage("Could not reach DigiTax. The submission status is unknown; verify it with DigiTax before retrying.");
    } finally {
      setSubmittingEtimsBillId(null);
    }
  };

  const settleRestaurantBill = async (bill: (typeof restaurantBills)[number]) => {
    const entered = (Object.entries(tenders) as [TenderType, string][])
      .filter(([, amount]) => Number(amount) > 0)
      .map(([type, amount]) => ({ type, amount: Number(amount), reference: type === "mpesa" ? mpesaReference : undefined }));
    if (entered.length === 1 && entered[0].type === "cash" && entered[0].amount >= bill.total) {
      entered[0].amount = bill.total;
    }
    const result = await settleTable(bill.table_id, entered, `cashier-pos-${bill.id}-${Date.now()}`);
    setMessage(result.message);
    if (result.success) {
      setTenders({ cash: "", mpesa: "", card: "" });
      setMpesaReference("");
      setSelectedBillId(null);
      const refreshed = await loadRestaurantBills(billDate);
      setBillsMessage(refreshed.success ? null : refreshed.message);
    }
  };

  const cancelRoomChargeForPayment = async (bill: (typeof restaurantBills)[number]) => {
    if (!activeProperty || !bill.room_charge_request_id) return;
    setBillsMessage(null);
    try {
      const response = await fetch("/api/restaurant/room-charges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          action: "cancel_for_payment",
          property_id: activeProperty.id,
          request_id: bill.room_charge_request_id,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setBillsMessage(data.message || "The pending room charge could not be cancelled.");
        return;
      }
      setMessage(data.message);
      setSelectedBillId(null);
      const refreshed = await loadRestaurantBills(billDate);
      setBillsMessage(refreshed.success ? null : refreshed.message);
    } catch {
      setBillsMessage("Could not reach the server to cancel this pending room charge.");
    }
  };

  return (
    <DashboardShell>
      <div className="min-h-[620px] flex flex-col gap-4 max-w-[1500px] mx-auto">
        <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800 pb-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight">{isRestaurantCashier ? "Restaurant Cashier" : "Touch POS Station"}</h1>
            <p className="text-xs text-neutral-500 font-mono mt-0.5">{isRestaurantCashier ? "Restaurant & bar • waiter bills, payments, reprints and shift control" : "Retail checkout, tenders, stock and shift control"}</p>
          </div>
          {cashierRoleMissingPermission && (
            <div role="alert" className="rounded border border-amber-400 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              Your “{activeRole?.name}” role does not currently have permission to clear restaurant bills. Ask an administrator to update the Cashier role, then sign out and back in.
            </div>
          )}
          {!activeShift ? (
            <div className="flex items-center gap-2">
              {canOpenShift ? (
                <>
                  <select aria-label="POS shift" value={shiftPeriod} onChange={(event) => setShiftPeriod(event.target.value as ShiftPeriod)} className="px-2 py-1.5 text-xs border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 rounded">
                    <option value="morning">Morning shift</option>
                    <option value="evening">Evening shift</option>
                  </select>
                  <input aria-label="POS shift business date" type="date" required min={today} max={today} value={shiftDate} onChange={(event) => setShiftDate(event.target.value)} className="px-2 py-1.5 text-xs font-mono border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 rounded" />
                  <input aria-label="Opening float" type="number" min="0" value={openingFloat} onChange={(event) => setOpeningFloat(event.target.value)} className="w-28 px-2 py-1.5 text-xs font-mono border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 rounded" placeholder="Opening float" />
                  <button type="button" disabled={shiftDate !== today || !activeOutlet || !activeStation} onClick={() => { void openShift("pos", shiftPeriod, shiftDate, Number(openingFloat)).then((result) => setMessage(result.message)); }} className="px-3 py-1.5 text-xs font-semibold bg-black text-white dark:bg-white dark:text-black rounded disabled:opacity-40">Open shift</button>
                </>
              ) : (
                <span className="px-2 py-1 text-xs font-mono bg-neutral-200 dark:bg-neutral-800 rounded">Only the cashier can open a shift</span>
              )}
            </div>
          ) : activeShift.status === "open" ? (
            <div className="flex items-center gap-2 text-xs font-mono">
              <span className="px-2 py-1 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded">
                POS • {activeShift.shift_period?.toUpperCase() ?? "LEGACY"} • {activeShift.business_date ?? "DATE N/A"}
              </span>
              {activeShift.cashier_id !== currentUser?.id ? (
                <span className="px-2 py-1 bg-neutral-200 dark:bg-neutral-800 rounded">Only the cashier who opened this shift can close it</span>
              ) : canCloseShift ? (
                <>
                  <label className="flex flex-col gap-0.5">
                    <span className="text-[9px] text-neutral-500">Expected KSh {(activeShift.opening_float + activeShift.cash_sales).toFixed(2)}</span>
                    <input aria-label="Counted cash" type="number" min="0" step="0.01" value={countedCash} onChange={(event) => setCountedCash(event.target.value)} className="w-36 px-2 py-1.5 border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 rounded" placeholder="Count actual cash" />
                    <span className="text-[9px] text-neutral-500">{countedCash.trim() === "" ? "Enter the actual count to enable closing." : `Entered: KSh ${Number(countedCash).toFixed(2)}`}</span>
                  </label>
                  <button type="button" disabled={countedCash.trim() === "" || closingShift} title={countedCash.trim() === "" ? "Enter the actual cash counted in the till first." : undefined} onClick={() => void submitCloseShift()} className="px-3 py-1.5 bg-neutral-200 dark:bg-neutral-800 rounded font-semibold disabled:opacity-40">
                    {closingShift ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Close"}
                  </button>
                </>
              ) : (
                <span className="px-2 py-1 bg-neutral-200 dark:bg-neutral-800 rounded">Your role does not have permission to close shifts</span>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs font-mono">
              <span className="px-2 py-1 bg-neutral-200 dark:bg-neutral-800 rounded">SHIFT CLOSED • VAR {activeShift.variance?.toFixed(2)}</span>
              {activeShift.manager_approval_required && (
                <span className="px-2 py-1 bg-amber-100 text-amber-800 border border-amber-300 rounded">MANAGER SIGN-OFF REQUIRED</span>
              )}
            </div>
          )}
        </div>

        {message && <div role="status" className="px-3 py-2 text-xs font-mono bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded">{message}</div>}

        {isRestaurantCashier ? (
          <section className="space-y-4 rounded border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">All waiter bills</h2>
                <p className="mt-1 text-[10px] font-mono text-neutral-500">Open bills stay visible until cleared; settled bills can be reprinted.</p>
              </div>
              <label className="space-y-1 text-[10px] font-mono text-neutral-500">
                Business date
                <input aria-label="Bill business date" type="date" max={today} value={billDate} onChange={(event) => setBillDate(event.target.value)} className="block rounded border border-neutral-300 bg-neutral-50 px-2 py-1.5 text-xs text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-white" />
              </label>
            </div>
            {billsMessage && <p role="alert" className="text-xs text-red-700 dark:text-red-300">{billsMessage}</p>}
            {billsLoading ? <p className="py-6 text-center text-xs text-neutral-500">Loading bills…</p> : restaurantBills.length === 0 ? (
              <p className="py-6 text-center text-xs text-neutral-500">No restaurant or bar bills for this date.</p>
            ) : (
              <div className="space-y-2">
                {restaurantBills.map((bill) => (
                  <details key={bill.id} className="rounded border border-neutral-200 dark:border-neutral-800">
                    <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 p-3">
                      <span className="text-xs font-semibold">{bill.table_name}</span>
                      <span className="text-[10px] font-mono text-neutral-500">Bill #{bill.bill_number} • Waiter {bill.waiter_name}</span>
                      <span className={`rounded border px-2 py-0.5 text-[10px] font-mono uppercase ${bill.status === "open" ? "border-amber-400 text-amber-800 dark:text-amber-300" : "border-emerald-500 text-emerald-700 dark:text-emerald-300"}`}>
                        {bill.room_charge_pending ? "Awaiting reception" : bill.status}
                      </span>
                      <span className="text-xs font-mono">KSh {bill.total.toFixed(2)}</span>
                    </summary>
                    <div className="space-y-3 border-t border-neutral-200 p-3 dark:border-neutral-800">
                      <div className="grid grid-cols-2 gap-2 text-[10px] font-mono text-neutral-500">
                        <span>Business date: {bill.business_date}</span>
                        <span>Cashier: {bill.cashier_name}</span>
                        <span>Created: {new Date(bill.created_at).toLocaleString()}</span>
                        {bill.settled_at && <span>Cleared: {new Date(bill.settled_at).toLocaleString()}</span>}
                        {bill.room_charge_pending && bill.room_charge_guest_name && <span className="col-span-2 text-amber-700 dark:text-amber-300">Awaiting reception approval for {bill.room_charge_guest_name}</span>}
                      </div>
                      {bill.status === "settled" && (
                        <div className={`rounded border p-2 text-[10px] ${bill.etims_status === "submitted" ? "border-emerald-300 text-emerald-800 dark:text-emerald-300" : "border-amber-300 text-amber-800 dark:text-amber-300"}`}>
                          <strong>eTIMS: {bill.etims_status ?? "not submitted"}</strong>
                          {bill.etims_status === "submitted" ? (
                            <div className="mt-1 space-y-1">
                              <div>Invoice {bill.etims_invoice_number} • Receipt {bill.etims_receipt_number ?? "—"}</div>
                              {bill.etims_verification_url && <a className="block underline" href={bill.etims_verification_url} target="_blank" rel="noreferrer">Verify fiscal receipt</a>}
                              <button type="button" onClick={() => printFiscalReceipt(bill)} className="rounded border border-current px-2 py-1 font-semibold">Reprint fiscal receipt</button>
                            </div>
                          ) : (
                            <div className="mt-1 space-y-2">
                              <p>Paid; no eTIMS receipt has been confirmed. {bill.etims_error ?? (bill.etims_status === "pending" || bill.etims_status === "unknown" || bill.etims_status === "failed" ? "Verify the sale with DigiTax before retrying." : "Enter the customer PIN if provided, then issue the eTIMS receipt.")}</p>
                              {(!bill.etims_status || bill.etims_status === "blocked" || bill.etims_status === "failed") && (
                                <div className="flex flex-wrap gap-2">
                                  <input
                                    aria-label={`Customer KRA PIN for bill ${bill.bill_number}`}
                                    autoComplete="off"
                                    maxLength={11}
                                    placeholder="Customer KRA PIN (optional)"
                                    value={customerPins[bill.id] ?? ""}
                                    onChange={(event) => setCustomerPins((current) => ({ ...current, [bill.id]: event.target.value.toUpperCase() }))}
                                    className="min-w-52 rounded border border-neutral-300 bg-white px-2 py-1.5 text-xs font-mono dark:border-neutral-700 dark:bg-neutral-900"
                                  />
                                  <input
                                    aria-label={`Customer name for bill ${bill.bill_number}`}
                                    autoComplete="off"
                                    maxLength={255}
                                    placeholder="Customer name (optional)"
                                    value={customerNames[bill.id] ?? ""}
                                    onChange={(event) => setCustomerNames((current) => ({ ...current, [bill.id]: event.target.value }))}
                                    className="min-w-52 rounded border border-neutral-300 bg-white px-2 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-900"
                                  />
                                  <button
                                    type="button"
                                    disabled={submittingEtimsBillId !== null}
                                    onClick={() => void submitEtimsReceipt(bill)}
                                    className="rounded border border-emerald-600 px-2 py-1 font-semibold text-emerald-800 disabled:opacity-50 dark:text-emerald-300"
                                  >
                                    {submittingEtimsBillId === bill.id ? "Submitting…" : bill.etims_status === "blocked" || bill.etims_status === "failed" ? "Retry failed submission" : "Issue eTIMS receipt"}
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                      <div className="space-y-1">
                        {bill.lines.map((line, index) => <div key={`${line.item.id}-${line.round}-${index}`} className="flex justify-between border-t border-neutral-100 pt-2 text-xs dark:border-neutral-800"><span>{line.quantity} × {line.item.name}</span><span>KSh {(line.item.price * line.quantity).toFixed(2)}</span></div>)}
                        {bill.payments.map((payment, index) => <div key={`${payment.type}-${index}`} className="text-[10px] font-mono text-neutral-500">Paid by {payment.type.toUpperCase()}: KSh {payment.amount.toFixed(2)}{payment.reference ? ` • ${payment.reference}` : ""}</div>)}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => printRestaurantBill(bill)} className="rounded border border-neutral-300 px-3 py-1.5 text-[10px] font-semibold dark:border-neutral-700">Reprint bill</button>
                        {bill.status === "open" && bill.room_charge_pending && canClearRestaurantBills && bill.room_charge_request_id && (
                          <button type="button" onClick={() => void cancelRoomChargeForPayment(bill)} className="rounded border border-amber-500 px-3 py-1.5 text-[10px] font-semibold text-amber-900 dark:text-amber-300">
                            Cancel room request to take payment
                          </button>
                        )}
                        {bill.status === "open" && !bill.room_charge_pending && (
                          <button type="button" onClick={() => { setSelectedBillId(selectedBillId === bill.id ? null : bill.id); setTenders({ cash: "", mpesa: "", card: "" }); setMpesaReference(""); }} className="rounded bg-black px-3 py-1.5 text-[10px] font-semibold text-white dark:bg-white dark:text-black">{selectedBillId === bill.id ? "Cancel payment" : "Clear bill"}</button>
                        )}
                        {bill.status === "open" && !bill.room_charge_pending && selectedBillId === bill.id && (
                          <div className="mt-2 w-full space-y-3 rounded border border-emerald-200 p-3 dark:border-emerald-900">
                            <div className="grid grid-cols-3 gap-2">
                              {([["cash", "Cash", Banknote], ["mpesa", "M-Pesa", Smartphone], ["card", "Card", CreditCard]] as const).map(([type, label, Icon]) => <label key={type} className="space-y-1"><span className="flex items-center gap-1 text-[10px] font-mono text-neutral-500"><Icon className="h-3 w-3" />{label}</span><input aria-label={`${label} received`} type="number" min="0" value={tenders[type]} onChange={(event) => setTenders({ ...tenders, [type]: event.target.value })} className="w-full rounded border border-neutral-200 bg-neutral-50 px-2 py-2 text-xs font-mono dark:border-neutral-700 dark:bg-neutral-800" /></label>)}
                            </div>
                            {Number(tenders.mpesa) > 0 && <input aria-label="M-Pesa transaction code" value={mpesaReference} onChange={(event) => setMpesaReference(event.target.value.toUpperCase())} placeholder="Verified M-Pesa transaction code" className="w-full rounded border border-neutral-200 bg-neutral-50 px-2 py-2 text-xs font-mono dark:border-neutral-700 dark:bg-neutral-800" />}
                            <div className="text-xs font-mono text-neutral-500">Bill total KSh {bill.total.toFixed(2)} • Payments must match exactly; cash change is calculated at checkout.</div>
                            <button type="button" onClick={() => void settleRestaurantBill(bill)} disabled={Math.abs(tenderTotal - bill.total) >= 0.01 && !(Number(tenders.cash) >= bill.total && Number(tenders.mpesa) === 0 && Number(tenders.card) === 0)} className="w-full rounded bg-emerald-700 py-2 text-xs font-bold text-white disabled:opacity-40"><WalletCards className="mr-1 inline h-4 w-4" />Record payment & clear bill</button>
                          </div>
                        )}
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            )}
            <p className="border-t border-neutral-200 pt-3 text-[10px] text-neutral-500 dark:border-neutral-800">DigiTax submissions are sent after payment. A pending status means DigiTax has queued the sale; it is not a confirmed eTIMS receipt yet.</p>
          </section>
        ) : <div className="flex-1 grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_390px] gap-4 min-h-0">
          <section className="relative z-10 min-h-[520px] flex flex-col bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-4">
            <div className="flex flex-col md:flex-row gap-2 mb-3">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-neutral-400" />
                <input aria-label="Search products" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, SKU or barcode" className="w-full pl-8 pr-3 py-2 text-xs font-mono border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded outline-none" />
              </div>
              <div className="flex gap-1 overflow-x-auto">
                {categoryLabels.map((item) => <button key={item.key} onClick={() => setCategory(item.key)} className={`px-2.5 py-1.5 text-xs whitespace-nowrap rounded border ${category === item.key ? "bg-black text-white dark:bg-white dark:text-black border-black dark:border-white" : "border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300"}`}>{item.label}</button>)}
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2 overflow-y-auto">
              {visibleItems.map((item) => <button key={item.id} onClick={() => addToCart(item)} disabled={!canOperatePos || !activeShift || (canReadInventory && item.stock_tracked && item.stock < 1) || (!canReadInventory && item.stock_tracked && item.stock_available === false)} className="text-left p-3 min-h-28 border border-neutral-200 dark:border-neutral-800 rounded hover:border-neutral-900 dark:hover:border-white disabled:opacity-40 disabled:cursor-not-allowed">
                <div className="flex items-start justify-between gap-2"><span className="font-semibold text-xs">{item.name}</span>{canOperatePos && <Plus className="w-3.5 h-3.5 shrink-0 text-neutral-500" />}</div>
                <div className="mt-3 text-base font-bold">KSh {item.price.toFixed(2)}</div>
                <div className="mt-1 text-[10px] font-mono text-neutral-500">{item.sku} • {canReadInventory ? `${item.stock} in stock` : item.stock_tracked ? (item.stock_available ? "Available" : "Out of stock") : "Not stock-tracked"}</div>
              </button>)}
            </div>
          </section>

          <section className="relative z-0 flex flex-col bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-4 min-h-[520px]">
            <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800 pb-3"><h2 className="font-semibold text-sm">Current sale</h2>{canOperatePos && <button onClick={clearCart} className="text-xs text-neutral-500 hover:text-black dark:hover:text-white flex items-center gap-1"><Trash2 className="w-3.5 h-3.5" /> Clear</button>}</div>
            <div className="flex-1 overflow-y-auto py-2 space-y-2">
              {cart.length === 0 ? <div className="h-full min-h-40 flex items-center justify-center text-xs font-mono text-neutral-400">Cart is empty</div> : cart.map((line) => <div key={line.item.id} className="flex items-center justify-between gap-2 py-2 border-b border-neutral-100 dark:border-neutral-800"><div className="min-w-0"><div className="text-xs font-semibold truncate">{line.item.name}</div><div className="text-[10px] font-mono text-neutral-500">KSh {line.item.price.toFixed(2)} each</div></div><div className="flex items-center gap-1">{canOperatePos && <button onClick={() => updateCartQuantity(line.item.id, line.quantity - 1)} className="p-1 border rounded"><Minus className="w-3 h-3" /></button>}<span className="w-6 text-center text-xs font-mono">{line.quantity}</span>{canOperatePos && <button onClick={() => updateCartQuantity(line.item.id, line.quantity + 1)} className="p-1 border rounded"><Plus className="w-3 h-3" /></button>}</div><span className="w-20 text-right text-xs font-mono">KSh {(line.item.price * line.quantity).toFixed(2)}</span></div>)}
            </div>
            <div className="border-t border-neutral-200 dark:border-neutral-800 pt-3 space-y-3"><div className="flex justify-between text-lg font-bold"><span>Total</span><span>KSh {total.toFixed(2)}</span></div>{canOperatePos ? <><div className="grid grid-cols-3 gap-2">{([['cash', 'Cash', Banknote], ['mpesa', 'M-Pesa', Smartphone], ['card', 'Card', CreditCard]] as const).map(([type, label, Icon]) => <label key={type} className="space-y-1"><span className="flex items-center gap-1 text-[10px] font-mono text-neutral-500"><Icon className="w-3 h-3" />{label}</span><input aria-label={`${label} tender`} type="number" min="0" value={tenders[type]} onChange={(event) => setTenders({ ...tenders, [type]: event.target.value })} className="w-full px-2 py-2 text-xs font-mono border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded" /></label>)}</div>{Number(tenders.mpesa) > 0 && <input aria-label="M-Pesa reference" value={mpesaReference} onChange={(event) => setMpesaReference(event.target.value.toUpperCase())} placeholder="M-Pesa reference e.g. QWE123RTY" className="w-full px-2 py-2 text-xs font-mono border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded" />}<div className={`text-xs font-mono ${Math.abs(tenderTotal - total) < 0.01 ? "text-emerald-600" : "text-neutral-500"}`}>Tendered KSh {tenderTotal.toFixed(2)} • {tenderTotal >= total ? `Change KSh ${(tenderTotal - total).toFixed(2)}` : `Due KSh ${(total - tenderTotal).toFixed(2)}`}</div><button onClick={submitCheckout} disabled={!activeShift || cart.length === 0 || Math.abs(tenderTotal - total) > 0.01} className="w-full py-2.5 bg-black text-white dark:bg-white dark:text-black disabled:opacity-30 disabled:cursor-not-allowed rounded text-xs font-bold flex items-center justify-center gap-2"><WalletCards className="w-4 h-4" /> Complete sale</button></> : <p className="text-xs text-neutral-500">Read-only POS access.</p>}</div>
          </section>
        </div>}
        {lastReceipt && <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"><div className="w-full max-w-sm bg-white dark:bg-neutral-900 border border-neutral-300 dark:border-neutral-700 rounded p-5 shadow-xl"><div className="flex items-start justify-between border-b border-dashed border-neutral-300 dark:border-neutral-700 pb-3"><div><h2 className="font-bold text-sm">KORE BENCH</h2><p className="text-[10px] font-mono text-neutral-500">Retail receipt • {lastReceipt.receipt_number}</p></div><button onClick={clearReceipt} className="text-xs text-neutral-500">Close</button></div><div className="py-3 space-y-2">{lastReceipt.lines.map((line) => <div key={line.item.id} className="flex justify-between text-xs font-mono"><span>{line.quantity} x {line.item.name}</span><span>KSh {(line.quantity * line.item.price).toFixed(2)}</span></div>)}</div><div className="border-t border-neutral-200 dark:border-neutral-800 pt-3 flex justify-between font-bold text-sm"><span>Total</span><span>KSh {lastReceipt.total.toFixed(2)}</span></div><div className="mt-2 text-[10px] font-mono text-neutral-500">{lastReceipt.tenders.map((tender) => <div key={`${tender.type}-${tender.amount}`}>{tender.type.toUpperCase()}: KSh {tender.amount.toFixed(2)}{tender.reference ? ` • ${tender.reference}` : ""}</div>)}</div><button onClick={() => window.print()} className="mt-4 w-full py-2 bg-black text-white dark:bg-white dark:text-black rounded text-xs font-semibold">Print receipt</button></div></div>}
      </div>
    </DashboardShell>
  );
}