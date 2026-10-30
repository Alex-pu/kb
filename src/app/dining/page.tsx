"use client";

import React, { useEffect, useMemo, useState } from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { useTenantStore } from "@/lib/store/tenant-store";
import { RestaurantTable, TableOrderLine, TableStatus, TenderType } from "@/lib/types/database";
import { ArrowLeftRight, Banknote, CreditCard, Minus, Plus, Receipt, Smartphone, Sparkles, WalletCards, X } from "lucide-react";

interface RestaurantRoomStay {
  booking_id: string;
  guest_name: string;
  room_number: string;
}

interface WaiterMpesaPayment {
  id: string;
  checkout_request_id: string;
  transaction_code: string;
  status: "pending" | "paid" | "failed" | "timeout";
  amount: number;
  bill_reference: string;
  payer_phone_suffix: string;
  callback_result_code: number | null;
  callback_result_description: string | null;
  cleared: boolean;
  applied_at: string | null;
  updated_at: string;
}

const statusStyles: Record<TableStatus, string> = {
  available: "border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900",
  occupied: "border-neutral-900 dark:border-white bg-neutral-100 dark:bg-neutral-800",
  bill_requested: "border-amber-400 bg-amber-50 dark:bg-amber-950/30",
  payment_pending: "border-amber-500 bg-amber-100 dark:bg-amber-950/50",
  cleaning: "border-neutral-300 bg-neutral-50 dark:bg-neutral-800/50 opacity-70",
};

const statusLabels: Record<TableStatus, string> = {
  available: "Available",
  occupied: "Occupied",
  bill_requested: "Bill requested",
  payment_pending: "Payment pending",
  cleaning: "Cleaning",
};

const ROOM_SERVICE_PREFIX = "room-service:";

function roomServiceTableName(roomNumber: string, guestName: string) {
  return `Room Service • Room ${roomNumber} • ${guestName}`.slice(0, 100);
}

function localDateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export default function DiningPage() {
  const {
    activeProperty,
    activeOutlet,
    currentUser,
    floorAreas,
    tables,
    menu,
    tableOrders,
    kots,
    restaurantChecks,
    restaurantBills,
    lastReceipt,
    addItemToTable,
    updateTableItemQuantity,
    updateTableLineInstructions,
    sendRoundToKitchen,
    requestBill,
    settleTable,
    markTableAvailable,
    transferTableOrder,
    requestRoomCharge,
    clearReceipt,
    loadRestaurantChecks,
    loadRestaurantKots,
    loadRestaurantBills,
    hasPermission,
  } = useTenantStore();
  const canManageRestaurant = hasPermission("restaurant:write");
  const canSettleRestaurant = hasPermission("restaurant:settle");
  const canViewAllBills = hasPermission("users:manage") || canSettleRestaurant;
  const todayDate = localDateInputValue(new Date());
  const earliestWaiterBillDate = localDateInputValue(new Date(Date.now() - 30 * 86400000));

  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [roomServiceBookingId, setRoomServiceBookingId] = useState("");
  const [instructionDrafts, setInstructionDrafts] = useState<Record<string, string>>({});
  const [billDate, setBillDate] = useState(todayDate);
  const [billHistoryLoading, setBillHistoryLoading] = useState(false);
  const [billHistoryMessage, setBillHistoryMessage] = useState<string | null>(null);
  const [transferTarget, setTransferTarget] = useState("");
  const [tenders, setTenders] = useState<Record<TenderType, string>>({ cash: "", mpesa: "", card: "" });
  const [mpesaReference, setMpesaReference] = useState("");
  const [payerPhone, setPayerPhone] = useState("");
  const [sendingMpesaPrompt, setSendingMpesaPrompt] = useState(false);
  const [mpesaPrompt, setMpesaPrompt] = useState<WaiterMpesaPayment | null>(null);
  const [mpesaPromptError, setMpesaPromptError] = useState<string | null>(null);
  const [roomChargeBookingId, setRoomChargeBookingId] = useState("");
  const [activeRoomStays, setActiveRoomStays] = useState<RestaurantRoomStay[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const activeStays = activeRoomStays;

  useEffect(() => {
    let cancelled = false;
    if (!activeOutlet) {
      setActiveRoomStays([]);
      return () => { cancelled = true; };
    }
    void (async () => {
      try {
        const params = new URLSearchParams({ outlet_id: activeOutlet.id });
        const response = await fetch(`/api/restaurant/room-charges?${params.toString()}`, { credentials: "include" });
        const value: unknown = await response.json();
        if (typeof value !== "object" || value === null || !("success" in value) || value.success !== true ||
            !("active_stays" in value) || !Array.isArray(value.active_stays)) {
          const errorMessage = typeof value === "object" && value !== null && "message" in value && typeof value.message === "string"
            ? value.message
            : "Active room stays could not be loaded.";
          if (!cancelled) {
            setActiveRoomStays([]);
            setMessage(errorMessage);
          }
          return;
        }
        const stays = value.active_stays.filter((item): item is RestaurantRoomStay =>
          typeof item === "object" && item !== null &&
          "booking_id" in item && typeof item.booking_id === "string" &&
          "guest_name" in item && typeof item.guest_name === "string" &&
          "room_number" in item && typeof item.room_number === "string",
        );
        if (!cancelled) setActiveRoomStays(stays);
      } catch {
        if (!cancelled) {
          setActiveRoomStays([]);
          setMessage("Could not reach the server. Active room stays were not loaded.");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [activeOutlet?.id]);

  useEffect(() => {
    let cancelled = false;
    if (!activeOutlet) {
      setMessage("Select an outlet before loading restaurant checks.");
      return () => { cancelled = true; };
    }
    setBillHistoryLoading(true);
    void Promise.all([
      loadRestaurantChecks(),
      loadRestaurantKots(),
      loadRestaurantBills(billDate),
    ]).then(([checks, tickets, bills]) => {
      if (cancelled) return;
      setMessage(!checks.success ? checks.message : !tickets.success ? tickets.message : null);
      setBillHistoryMessage(bills.success ? null : bills.message);
      setBillHistoryLoading(false);
    }).catch(() => {
      if (!cancelled) {
        setBillHistoryMessage("Restaurant bills could not be loaded.");
        setBillHistoryLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [activeOutlet?.id, billDate, loadRestaurantBills, loadRestaurantChecks, loadRestaurantKots]);

  useEffect(() => {
    if (!activeOutlet || (!canManageRestaurant && !canSettleRestaurant)) return;
    const interval = window.setInterval(() => {
      void loadRestaurantChecks().then((result) => {
        if (!result.success) setMessage(result.message);
        if (selectedTableId && restaurantChecks[selectedTableId] &&
            !useTenantStore.getState().restaurantChecks[selectedTableId]) {
          setSelectedTableId(null);
          setMessage("M-Pesa callback confirmed. The bill has been cleared.");
        }
      });
      void loadRestaurantBills(billDate).then((result) => {
        setBillHistoryMessage(result.success ? null : result.message);
      });
    }, 5000);
    return () => window.clearInterval(interval);
  }, [activeOutlet?.id, billDate, canManageRestaurant, canSettleRestaurant, loadRestaurantBills, loadRestaurantChecks, restaurantChecks, selectedTableId]);

  useEffect(() => {
    if (!activeOutlet || !mpesaPrompt ||
        (mpesaPrompt.status !== "pending" && !(mpesaPrompt.status === "paid" && !mpesaPrompt.cleared))) return;
    let cancelled = false;
    let attempts = 0;
    let timer: number | undefined;

    const pollStatus = async () => {
      attempts += 1;
      const maxAttempts = mpesaPrompt.status === "pending" ? 120 : 10;
      try {
        const params = new URLSearchParams({
          outlet_id: activeOutlet.id,
          checkout_request_id: mpesaPrompt.checkout_request_id,
        });
        const response = await fetch(`/api/integrations/daraja/prompt?${params.toString()}`, {
          credentials: "include",
          cache: "no-store",
        });
        const value: unknown = await response.json();
        if (!response.ok || typeof value !== "object" || value === null ||
            !("success" in value) || value.success !== true ||
            !("payment" in value) || typeof value.payment !== "object" || value.payment === null) {
          throw new Error(
            typeof value === "object" && value !== null && "message" in value && typeof value.message === "string"
              ? value.message
              : "M-Pesa payment status could not be checked.",
          );
        }

        const payment = value.payment as WaiterMpesaPayment;
        if (cancelled) return;
        setMpesaPrompt(payment);
        setMpesaPromptError(null);
        if (payment.status === "paid" && payment.cleared) {
          setMessage(`M-Pesa payment received. Bill ${payment.bill_reference} is paid and cleared.`);
        } else if (payment.status === "paid") {
          setMessage(`M-Pesa payment received for bill ${payment.bill_reference}, but the bill is not cleared yet. Ask the cashier to review it.`);
        } else if (payment.status === "failed" || payment.status === "timeout") {
          setMessage(`M-Pesa prompt ${payment.status === "timeout" ? "timed out" : "was not paid"} for bill ${payment.bill_reference}.`);
        }

        const paymentMayStillChange = payment.status === "pending" || (payment.status === "paid" && !payment.cleared);
        const paymentMaxAttempts = payment.status === "pending" ? 120 : 10;
        if (paymentMayStillChange && attempts < paymentMaxAttempts) {
          timer = window.setTimeout(() => void pollStatus(), 3000);
        } else if (paymentMayStillChange) {
          setMpesaPromptError(payment.status === "pending"
            ? "No payment callback arrived yet. Check the customer's phone and verify the payment before sending another prompt."
            : "Payment is confirmed, but the bill has not cleared. Ask the cashier to review the bill before retrying.");
        }
      } catch (error) {
        if (cancelled) return;
        setMpesaPromptError(error instanceof Error ? error.message : "M-Pesa payment status could not be checked.");
        if (attempts < maxAttempts) timer = window.setTimeout(() => void pollStatus(), 5000);
      }
    };

    timer = window.setTimeout(() => void pollStatus(), 2500);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeOutlet?.id, mpesaPrompt?.checkout_request_id, mpesaPrompt?.status, mpesaPrompt?.cleared]);

  const selectedCheck = selectedTableId ? restaurantChecks[selectedTableId] : undefined;
  const selectedRoomStay = selectedTableId?.startsWith(ROOM_SERVICE_PREFIX)
    ? activeStays.find((stay) => stay.booking_id === selectedTableId.slice(ROOM_SERVICE_PREFIX.length))
    : undefined;
  const selectedTable = selectedTableId
    ? tables.find((table) => table.id === selectedTableId) || (selectedTableId.startsWith(ROOM_SERVICE_PREFIX)
      ? {
        id: selectedTableId,
        floor_area_id: "room-service",
        outlet_id: activeOutlet?.id || "",
        property_id: activeProperty?.id || "",
        name: selectedRoomStay
          ? roomServiceTableName(selectedRoomStay.room_number, selectedRoomStay.guest_name)
          : selectedCheck?.table_name || "Room Service",
        capacity: 1,
        status: selectedCheck ? "occupied" as const : "available" as const,
      }
      : null)
    : null;
  const canManageSelectedTable = canManageRestaurant &&
    (!selectedCheck || selectedCheck.waiter_id === currentUser?.id);
  const canSettleSelectedTable = canSettleRestaurant && Boolean(selectedCheck);
  const orderLines = selectedTableId ? tableOrders[selectedTableId] || [] : [];
  const total = orderLines.reduce((sum, line) => sum + line.item.price * line.quantity, 0);
  const tenderTotal = Object.values(tenders).reduce((sum, amount) => sum + Number(amount || 0), 0);
  const cashChangeAllowed = Number(tenders.cash) >= total &&
    Number(tenders.mpesa) === 0 && Number(tenders.card) === 0;
  const settlementAmountValid = Math.abs(tenderTotal - total) < 0.01 || cashChangeAllowed;
  const mpesaReferenceValid = Number(tenders.mpesa) <= 0 || Boolean(mpesaReference.trim());
  const hasUnsentItems = orderLines.some((line) => !line.sentToKitchen);
  const tablesByArea = useMemo(() => floorAreas.map((area) => ({
    area,
    tables: tables.filter((table) => table.floor_area_id === area.id),
  })), [floorAreas, tables]);

  const openTable = (table: RestaurantTable) => {
    setSelectedTableId(table.id);
    setMpesaPrompt(null);
    setMpesaPromptError(null);
    if (table.id.startsWith(ROOM_SERVICE_PREFIX)) {
      setRoomChargeBookingId(table.id.slice(ROOM_SERVICE_PREFIX.length));
    } else {
      setRoomChargeBookingId("");
    }
    setTenders({ cash: "", mpesa: "", card: "" });
    setMpesaReference("");
    setMessage(null);
  };

  const reloadBillHistory = async () => {
    setBillHistoryLoading(true);
    const result = await loadRestaurantBills(billDate);
    setBillHistoryMessage(result.success ? null : result.message);
    setBillHistoryLoading(false);
  };

  const printRestaurantBill = (bill: (typeof restaurantBills)[number]) => {
    const printWindow = window.open("", "_blank", "width=420,height=720");
    if (!printWindow) {
      setMessage("The bill could not be opened for printing. Allow pop-ups and try again.");
      return;
    }
    const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character] ?? character);
    const paymentLines = bill.payments.map((payment) =>
      `<p>${escapeHtml(payment.type.toUpperCase())}: KSh ${Number(payment.amount).toFixed(2)}${payment.reference ? ` • ${escapeHtml(payment.reference)}` : ""}</p>`
    ).join("");
    const itemLines = bill.lines.map((line) =>
      `<div class="line"><span>${line.quantity} × ${escapeHtml(line.item.name)}</span><span>KSh ${(line.item.price * line.quantity).toFixed(2)}</span></div>`
    ).join("");
    printWindow.document.write(`<!doctype html><html><head><title>Restaurant bill ${escapeHtml(bill.table_name)}</title>
      <style>body{font:14px Arial,sans-serif;max-width:360px;margin:24px auto;color:#111}h1,h2,p{margin:0 0 8px}h1{font-size:18px}.muted{color:#555;font-size:12px}.line{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px dashed #bbb}.total{display:flex;justify-content:space-between;margin-top:14px;padding-top:10px;border-top:2px solid #111;font-size:16px;font-weight:bold}.payments{margin-top:12px;font-size:12px}.status{font-weight:bold;text-transform:uppercase;margin:12px 0}</style>
      </head><body><h1>KORE BENCH</h1><p>Restaurant bill • ${escapeHtml(bill.table_name)}</p>
      <p class="muted">Bill: ${escapeHtml(bill.bill_number)}<br>Waiter: ${escapeHtml(bill.waiter_name)}<br>Cashier: ${escapeHtml(bill.cashier_name)}<br>${escapeHtml(bill.business_date)} • ${new Date(bill.created_at).toLocaleString()}</p>
      <p class="status">${bill.room_charge_pending ? "Awaiting reception approval" : bill.status}</p>${itemLines}
      <div class="total"><span>Total</span><span>KSh ${bill.total.toFixed(2)}</span></div>${paymentLines ? `<div class="payments"><h2>Payments</h2>${paymentLines}</div>` : ""}
      <script>window.onload=()=>window.print()</script></body></html>`);
    printWindow.document.close();
  };

  const sendMpesaPrompt = async () => {
    if (!selectedTableId || !selectedCheck || !activeProperty || !activeOutlet || !payerPhone.trim() || sendingMpesaPrompt) return;
    if (!Number.isInteger(total)) {
      setMpesaPromptError("M-Pesa STK prompts require a whole-number amount in Kenyan shillings.");
      return;
    }
    setSendingMpesaPrompt(true);
    setMpesaPrompt(null);
    setMpesaPromptError(null);
    try {
      const response = await fetch("/api/integrations/daraja/prompt", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          property_id: activeProperty.id,
          outlet_id: activeOutlet.id,
          order_id: selectedCheck.bill_number,
          bill_reference: selectedCheck.bill_number,
          amount: total,
          payer_phone: payerPhone.trim(),
        }),
      });
      const value: unknown = await response.json();
      const responseMessage = typeof value === "object" && value !== null && "message" in value && typeof value.message === "string"
        ? value.message
        : "M-Pesa prompt request could not be confirmed.";
      if (!response.ok || typeof value !== "object" || value === null ||
          !("success" in value) || value.success !== true ||
          !("payment" in value) || typeof value.payment !== "object" || value.payment === null) {
        throw new Error(responseMessage);
      }
      const payment = value.payment as WaiterMpesaPayment;
      if (!payment.id || !payment.checkout_request_id) {
        throw new Error("Daraja accepted the prompt, but its request ID could not be saved. Verify payment status before retrying.");
      }
      setMpesaPrompt(payment);
      setMessage(`M-Pesa prompt sent to phone ending ${payment.payer_phone_suffix}. Waiting for customer approval.`);
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : "Could not reach the server. The M-Pesa prompt status is unknown; verify before retrying.";
      setMpesaPromptError(errorMessage);
      setMessage(errorMessage);
    } finally {
      setSendingMpesaPrompt(false);
    }
  };

  const submitSettle = async () => {
    if (!selectedTableId) return;
    const tenderLines = (Object.entries(tenders) as [TenderType, string][])
      .filter(([, amount]) => Number(amount) > 0)
      .map(([type, amount]) => ({ type, amount: Number(amount), reference: type === "mpesa" ? mpesaReference : undefined }));
    if (tenderLines.length === 1 && tenderLines[0].type === "cash" && tenderLines[0].amount >= total) {
      tenderLines[0].amount = total;
    }
    const result = await settleTable(
      selectedTableId,
      tenderLines,
      `dine-checkout-${Date.now()}`,
    );
    setMessage(result.message);
    if (result.success) {
      setSelectedTableId(null);
      await reloadBillHistory();
      setTenders({ cash: "", mpesa: "", card: "" });
      setMpesaReference("");
      setPayerPhone("");
    }
  };

  const submitTransfer = () => {
    if (!selectedTableId || !transferTarget) return;
    const result = transferTableOrder(selectedTableId, transferTarget);
    setMessage(result.message);
    if (result.success) {
      setSelectedTableId(transferTarget);
      setTransferTarget("");
    }
  };

  const savePreparationInstructions = async (tableId: string, line: TableOrderLine, instructions: string) => {
    const key = `${tableId}:${line.item.id}:${line.round}`;
    const result = await updateTableLineInstructions(tableId, line.item.id, line.round, instructions);
    setMessage(result.message);
    if (result.success) {
      await reloadBillHistory();
      setInstructionDrafts((drafts) => {
        const { [key]: _savedDraft, ...remainingDrafts } = drafts;
        return remainingDrafts;
      });
    }
  };

  return (
    <DashboardShell>
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800 pb-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Floor Plan & Tables</h1>
            <p className="text-xs text-neutral-500 font-mono mt-0.5">Phase 2 • Dine-in ordering, table lifecycle, transfer & settlement</p>
          </div>
        </div>

        {message && <div role="status" className="px-3 py-2 text-xs font-mono bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded">{message}</div>}

        {mpesaPrompt && (
          <section aria-live="polite" className="rounded border border-neutral-200 bg-white p-3 text-xs dark:border-neutral-800 dark:bg-neutral-900">
            <div className="font-semibold">
              {mpesaPrompt.status === "pending" && "M-Pesa prompt sent — awaiting customer approval"}
              {mpesaPrompt.status === "paid" && mpesaPrompt.cleared && "M-Pesa payment received — bill cleared"}
              {mpesaPrompt.status === "paid" && !mpesaPrompt.cleared && "M-Pesa payment received — bill not cleared"}
              {mpesaPrompt.status === "failed" && "M-Pesa payment was cancelled or declined"}
              {mpesaPrompt.status === "timeout" && "M-Pesa prompt timed out"}
            </div>
            <div className="mt-1 space-y-0.5 font-mono text-[10px] text-neutral-500">
              <p>Bill {mpesaPrompt.bill_reference} · KSh {mpesaPrompt.amount.toFixed(2)} · phone ending {mpesaPrompt.payer_phone_suffix}</p>
              <p>Daraja checkout request ID: {mpesaPrompt.checkout_request_id}</p>
              {mpesaPrompt.status === "paid" && mpesaPrompt.transaction_code !== mpesaPrompt.checkout_request_id &&
                <p>M-Pesa receipt: {mpesaPrompt.transaction_code}</p>}
              {mpesaPrompt.callback_result_description && <p>Daraja result: {mpesaPrompt.callback_result_description}</p>}
              {mpesaPrompt.status === "pending" && !mpesaPromptError && <p>Waiting for the callback; this status refreshes automatically.</p>}
              {mpesaPrompt.status === "paid" && !mpesaPrompt.cleared &&
                <p>Ask the cashier to review and settle the bill; the payment is confirmed but not yet applied.</p>}
              {mpesaPrompt.cleared && mpesaPrompt.applied_at &&
                <p>Bill cleared at {new Date(mpesaPrompt.applied_at).toLocaleString()}.</p>}
            </div>
            {mpesaPromptError && <p role="alert" className="mt-2 text-[10px] text-amber-700 dark:text-amber-300">{mpesaPromptError}</p>}
          </section>
        )}

        <section className="rounded border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">{canViewAllBills ? "Restaurant bill history" : "My bills"}</h2>
              <p className="text-[10px] font-mono text-neutral-500 mt-1">
                {canViewAllBills ? "All waiters • any past business date" : "Your bills • today and the previous 30 days"}
              </p>
            </div>
            <div className="flex items-end gap-2">
              <label className="space-y-1 text-[10px] font-mono text-neutral-500">
                Business date
                <input
                  aria-label="Bill business date"
                  type="date"
                  value={billDate}
                  min={canViewAllBills ? undefined : earliestWaiterBillDate}
                  max={todayDate}
                  onChange={(event) => setBillDate(event.target.value)}
                  className="block rounded border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 px-2 py-1.5 text-xs text-neutral-900 dark:text-white"
                />
              </label>
              <button
                onClick={() => { void reloadBillHistory(); }}
                disabled={billHistoryLoading}
                className="px-3 py-1.5 border border-neutral-300 dark:border-neutral-700 rounded text-xs font-semibold disabled:opacity-50"
              >
                {billHistoryLoading ? "Loading…" : "Refresh"}
              </button>
            </div>
          </div>

          {billHistoryMessage && <p role="alert" className="text-xs text-red-700 dark:text-red-300">{billHistoryMessage}</p>}
          {billHistoryLoading ? (
            <p className="py-4 text-center text-xs text-neutral-500">Loading bills…</p>
          ) : restaurantBills.length === 0 ? (
            <p className="py-4 text-center text-xs text-neutral-500">No bills found for this date.</p>
          ) : (
            <div className="space-y-2">
              {restaurantBills.map((bill) => {
                const table = tables.find((candidate) => candidate.id === bill.table_id);
                const historyTable: RestaurantTable = table || {
                  id: bill.table_id,
                  floor_area_id: "room-service",
                  outlet_id: activeOutlet?.id || "",
                  property_id: activeProperty?.id || "",
                  name: bill.table_name,
                  capacity: 1,
                  status: "occupied",
                };
                const canOpenBill = bill.status === "open" && !bill.room_charge_pending &&
                  (canSettleRestaurant || (canManageRestaurant && bill.waiter_id === currentUser?.id));
                const kitchenStatus = bill.kitchen_tickets.length
                  ? bill.kitchen_tickets.map((ticket) => `${ticket.station} R${ticket.round}: ${ticket.status}`).join(" • ")
                  : "Not sent to kitchen";
                const statusClass = bill.status === "open"
                  ? "border-amber-400 text-amber-800 dark:text-amber-300"
                  : bill.status === "settled"
                    ? "border-emerald-500 text-emerald-700 dark:text-emerald-300"
                    : "border-neutral-400 text-neutral-500";
                return (
                  <details key={bill.id} className="rounded border border-neutral-200 dark:border-neutral-800">
                    <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 p-3">
                      <span className="font-semibold text-xs">{bill.table_name}</span>
                      <span className={`rounded border px-2 py-0.5 text-[10px] font-mono uppercase ${statusClass}`}>
                        {bill.room_charge_pending ? "Awaiting reception" : bill.status}
                      </span>
                      <span className="text-xs font-mono">KSh {bill.total.toFixed(2)}</span>
                      <span className="text-[10px] font-mono text-neutral-500">{new Date(bill.created_at).toLocaleTimeString()}</span>
                    </summary>
                    <div className="border-t border-neutral-200 dark:border-neutral-800 p-3 space-y-3">
                      <div className="grid grid-cols-2 gap-2 text-[10px] font-mono text-neutral-500">
                        <span>Bill no: {bill.bill_number}</span>
                        <span>Waiter: {bill.waiter_name}</span>
                        <span>Cashier: {bill.cashier_name}</span>
                        <span>Shift: {bill.shift_period || "—"} • {bill.business_date}</span>
                        {bill.room_charge_pending && bill.room_charge_guest_name && (
                          <span className="col-span-2 text-amber-700 dark:text-amber-300">
                            Room charge pending approval for {bill.room_charge_guest_name}
                          </span>
                        )}
                        <span>Kitchen: {kitchenStatus}</span>
                        {bill.settled_at && <span>Settled: {new Date(bill.settled_at).toLocaleString()}</span>}
                        {bill.payments.map((payment, index) => (
                          <span key={`${payment.type}-${index}`} className="col-span-2">
                            Paid by {payment.type.toUpperCase()}: KSh {payment.amount.toFixed(2)}{payment.reference ? ` • ${payment.reference}` : ""}
                          </span>
                        ))}
                      </div>
                      <div className="space-y-1">
                        {bill.lines.map((line, index) => (
                          <div key={`${line.item.id}-${line.round}-${index}`} className="border-t border-neutral-100 dark:border-neutral-800 pt-2 text-xs">
                            <div className="flex justify-between gap-2">
                              <span>{line.quantity} × {line.item.name}</span>
                              <span className="font-mono">KSh {(line.item.price * line.quantity).toFixed(2)}</span>
                            </div>
                            {line.instructions && <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">Prep: {line.instructions}</p>}
                          </div>
                        ))}
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => printRestaurantBill(bill)} className="px-3 py-1.5 border border-neutral-300 dark:border-neutral-700 rounded text-[10px] font-semibold">
                          Reprint bill
                        </button>
                        {canOpenBill && (
                          <button onClick={() => openTable(historyTable)} className="px-3 py-1.5 border border-neutral-300 dark:border-neutral-700 rounded text-[10px] font-semibold">
                            {canSettleRestaurant ? "Clear bill" : "Open bill"}
                          </button>
                        )}
                      </div>
                    </div>
                  </details>
                );
              })}
            </div>
          )}
        </section>

        <div className="space-y-6">
          {tablesByArea.map(({ area, tables: areaTables }) => (
            <div key={area.id}>
              <h2 className="text-xs font-mono font-semibold uppercase tracking-wider text-neutral-500 mb-2">{area.name}</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {areaTables.map((table) => {
                  const lines = tableOrders[table.id] || [];
                  const tableTotal = lines.reduce((sum, line) => sum + line.item.price * line.quantity, 0);
                  return (
                    <button
                      key={table.id}
                      onClick={() => openTable(table)}
                      className={`text-left p-3 rounded border-2 min-h-24 transition-colors ${statusStyles[table.status]} ${selectedTableId === table.id ? "ring-2 ring-neutral-900 dark:ring-white" : ""}`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-sm">{table.name}</span>
                        <span className="text-[10px] font-mono text-neutral-500">{table.capacity} seats</span>
                      </div>
                      <div className="mt-2 text-[10px] font-mono uppercase tracking-wide">{statusLabels[table.status]}</div>
                      {tableTotal > 0 && <div className="mt-1 text-xs font-mono font-semibold">KSh {tableTotal.toFixed(2)}</div>}
                      {table.status === "cleaning" && canManageRestaurant && (
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(event) => { event.stopPropagation(); markTableAvailable(table.id); }}
                          className="mt-2 inline-flex items-center gap-1 text-[10px] font-mono underline"
                        >
                          <Sparkles className="w-3 h-3" /> Mark clean
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {canManageRestaurant && <section className="rounded border border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/10 p-4 space-y-3">
          <div>
            <h2 className="text-sm font-semibold">Room Service</h2>
            <p className="mt-1 text-[10px] text-neutral-500">Create a restaurant order for an in-house guest. Orders go to the kitchen and can be paid normally or requested for folio approval.</p>
          </div>
          {activeStays.length === 0 ? (
            <p className="text-xs text-neutral-500">There are no checked-in guests to serve right now.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              <select
                aria-label="Select in-house guest for room service"
                value={roomServiceBookingId}
                onChange={(event) => setRoomServiceBookingId(event.target.value)}
                className="min-w-56 flex-1 rounded border border-neutral-300 bg-white px-3 py-2 text-xs dark:border-neutral-700 dark:bg-neutral-900"
              >
                <option value="">Select guest room…</option>
                {activeStays.map((stay) => (
                  <option key={stay.booking_id} value={stay.booking_id}>
                    Room {stay.room_number} • {stay.guest_name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!roomServiceBookingId || !canManageRestaurant}
                onClick={() => {
                  const stay = activeStays.find((candidate) => candidate.booking_id === roomServiceBookingId);
                  if (!stay) return;
                  const tableId = `${ROOM_SERVICE_PREFIX}${stay.booking_id}`;
                  const table: RestaurantTable = {
                    id: tableId,
                    floor_area_id: "room-service",
                    outlet_id: activeOutlet?.id || "",
                    property_id: activeProperty?.id || "",
                    name: roomServiceTableName(stay.room_number, stay.guest_name),
                    capacity: 1,
                    status: restaurantChecks[tableId] ? "occupied" : "available",
                  };
                  openTable(table);
                }}
                className="rounded bg-emerald-700 px-4 py-2 text-xs font-semibold text-white disabled:opacity-40"
              >
                {roomServiceBookingId && restaurantChecks[`${ROOM_SERVICE_PREFIX}${roomServiceBookingId}`] ? "Open room order" : "Start room order"}
              </button>
            </div>
          )}
        </section>}

        {selectedTable && (
          <div className="fixed inset-0 z-40 bg-black/50 flex items-center justify-end">
            <div className="w-full max-w-md h-full bg-white dark:bg-neutral-900 border-l border-neutral-300 dark:border-neutral-700 p-4 overflow-y-auto space-y-4">
              <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800 pb-3">
                <div>
                  <h2 className="font-bold text-sm">{selectedTable.name} • {statusLabels[selectedTable.status]}</h2>
                  <p className="text-[10px] font-mono text-neutral-500">
                    {selectedRoomStay
                      ? `Room ${selectedRoomStay.room_number} · ${selectedRoomStay.guest_name}`
                      : floorAreas.find((area) => area.id === selectedTable.floor_area_id)?.name}
                  </p>
                  {selectedCheck && (
                    <p className="text-[10px] font-mono text-neutral-500 mt-1">
                      Waiter: {selectedCheck.waiter_name} • Cashier: {selectedCheck.cashier_name}
                    </p>
                  )}
                </div>
                <button onClick={() => setSelectedTableId(null)}><X className="w-4 h-4" /></button>
              </div>

              <div>
                <div className="text-[10px] font-mono font-semibold uppercase text-neutral-400 mb-2">Menu</div>
                <div className="grid grid-cols-2 gap-2">
                  {menu.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => { void addItemToTable(selectedTable.id, item).then(async (result) => { setMessage(result.message); if (result.success) await reloadBillHistory(); }); }}
                      disabled={!canManageSelectedTable}
                      className="text-left p-2.5 border border-neutral-200 dark:border-neutral-800 rounded hover:border-neutral-900 dark:hover:border-white disabled:opacity-50"
                    >
                      <div className="text-xs font-semibold">{item.name}</div>
                      <div className="text-[10px] font-mono text-neutral-500">KSh {item.price.toFixed(2)} • {item.prep_station === "bar" ? "Bar" : "Kitchen"}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-mono font-semibold uppercase text-neutral-400">Current order</span>
                  {selectedCheck && <span className="text-[10px] font-mono font-semibold text-neutral-500">Bill #{selectedCheck.bill_number}</span>}
                  {canManageSelectedTable && hasUnsentItems && (
                    <button
                      onClick={() => { void sendRoundToKitchen(selectedTable.id).then(async (result) => { setMessage(result.message); if (result.success) await reloadBillHistory(); }); }}
                      className="text-[10px] font-mono px-2 py-1 bg-neutral-900 text-white dark:bg-white dark:text-black rounded"
                    >
                      Send round to stations
                    </button>
                  )}
                </div>
                {kots.filter((kot) => kot.table_id === selectedTable.id && kot.status !== "served" && kot.status !== "cancelled").length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {kots.filter((kot) => kot.table_id === selectedTable.id && kot.status !== "served" && kot.status !== "cancelled").map((kot) => (
                      <span key={kot.id} className="text-[10px] font-mono px-2 py-1 border border-neutral-300 dark:border-neutral-700 rounded uppercase">
                        {kot.station} R{kot.round} • {kot.status}
                      </span>
                    ))}
                  </div>
                )}
                <div className="space-y-2">
                  {orderLines.length === 0 ? (
                    <div className="text-xs font-mono text-neutral-400 py-6 text-center">No items yet</div>
                  ) : orderLines.map((line) => {
                    const instructionKey = `${selectedTable.id}:${line.item.id}:${line.round}`;
                    const instructionValue = instructionDrafts[instructionKey] ?? line.instructions ?? "";
                    return (
                      <div key={`${line.item.id}-${line.round}`} className="py-2 border-b border-neutral-100 dark:border-neutral-800">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-xs font-semibold truncate">{line.item.name}</div>
                            <div className="text-[10px] font-mono text-neutral-500">
                              Round {line.round}{line.sentToKitchen ? ` • Sent to ${line.item.prep_station === "bar" ? "bar" : "kitchen"}` : " • Pending"}
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            {canManageSelectedTable && !line.sentToKitchen && <button onClick={() => { void updateTableItemQuantity(selectedTable.id, line.item.id, line.quantity - 1, line.round).then(async (result) => { setMessage(result.message); if (result.success) await reloadBillHistory(); }); }} className="p-1 border rounded"><Minus className="w-3 h-3" /></button>}
                            <span className="w-6 text-center text-xs font-mono">{line.quantity}</span>
                            {canManageSelectedTable && !line.sentToKitchen && <button onClick={() => { void updateTableItemQuantity(selectedTable.id, line.item.id, line.quantity + 1, line.round).then(async (result) => { setMessage(result.message); if (result.success) await reloadBillHistory(); }); }} className="p-1 border rounded"><Plus className="w-3 h-3" /></button>}
                          </div>
                          <span className="w-20 text-right text-xs font-mono">KSh {(line.item.price * line.quantity).toFixed(2)}</span>
                        </div>
                        {canManageSelectedTable && !line.sentToKitchen ? (
                          <textarea
                            aria-label={`Preparation instructions for ${line.item.name}`}
                            value={instructionValue}
                            maxLength={500}
                            rows={2}
                            onChange={(event) => setInstructionDrafts((drafts) => ({ ...drafts, [instructionKey]: event.target.value }))}
                            onBlur={(event) => { void savePreparationInstructions(selectedTable.id, line, event.currentTarget.value); }}
                            placeholder="Preparation instructions (optional)"
                            className="mt-2 w-full resize-y rounded border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 px-2 py-1.5 text-xs"
                          />
                        ) : line.instructions ? (
                          <p className="mt-2 text-[10px] text-amber-700 dark:text-amber-300">Prep: {line.instructions}</p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>

              {orderLines.length > 0 && (
                <div className="border-t border-neutral-200 dark:border-neutral-800 pt-3 space-y-3">
                  <div className="flex justify-between text-base font-bold"><span>Total</span><span>KSh {total.toFixed(2)}</span></div>
                  {(canManageSelectedTable || canSettleSelectedTable) && <>

                  {canManageSelectedTable && <div className="flex gap-2">
                    <button onClick={() => requestBill(selectedTable.id)} className="flex-1 py-2 border border-neutral-300 dark:border-neutral-700 rounded text-xs font-semibold flex items-center justify-center gap-1.5">
                      <Receipt className="w-3.5 h-3.5" /> Request bill
                    </button>
                    {!selectedCheck ? (
                      <div className="flex-1 flex gap-1">
                        <select value={transferTarget} onChange={(event) => setTransferTarget(event.target.value)} className="flex-1 text-xs border border-neutral-300 dark:border-neutral-700 rounded bg-neutral-50 dark:bg-neutral-800 px-1">
                          <option value="">Transfer to…</option>
                          {tables.filter((table) => table.id !== selectedTable.id && table.status === "available").map((table) => (
                            <option key={table.id} value={table.id}>{table.name}</option>
                          ))}
                        </select>
                        <button onClick={submitTransfer} disabled={!transferTarget} className="px-2 border border-neutral-300 dark:border-neutral-700 rounded disabled:opacity-30"><ArrowLeftRight className="w-3.5 h-3.5" /></button>
                      </div>
                    ) : (
                      <p className="flex-1 self-center text-[10px] text-neutral-500">Transfer unavailable while a persisted bill is open.</p>
                    )}
                  </div>}

                  {canManageSelectedTable && selectedCheck && (
                    <div className="border border-dashed border-neutral-300 dark:border-neutral-700 rounded p-3 space-y-2">
                      <div className="text-[10px] font-mono font-semibold uppercase text-neutral-400">M-Pesa self-service</div>
                      <input aria-label="Guest M-Pesa phone" value={payerPhone} onChange={(event) => setPayerPhone(event.target.value)} placeholder="Guest phone number" className="w-full px-2 py-2 text-xs font-mono border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded" />
                      <button type="button" onClick={() => void sendMpesaPrompt()} disabled={!payerPhone.trim() || total <= 0 || sendingMpesaPrompt} className="w-full px-3 py-2 bg-black text-white dark:bg-white dark:text-black rounded text-[10px] font-semibold disabled:opacity-40">
                        {sendingMpesaPrompt ? "Sending prompt…" : "Send M-Pesa prompt"}
                      </button>
                      {mpesaPromptError && <p role="alert" className="text-[10px] text-red-600 dark:text-red-400">{mpesaPromptError}</p>}
                      <p className="text-[10px] text-neutral-400">Account reference: {selectedCheck.bill_number}. The bill clears only after a successful callback confirms this bill number and exact amount.</p>
                    </div>
                  )}

                  {canManageSelectedTable && activeStays.length > 0 && selectedCheck && (
                    <div className="border-t border-dashed border-neutral-300 dark:border-neutral-700 pt-3 space-y-2">
                      <div className="text-[10px] font-mono font-semibold uppercase text-neutral-400">Charge this bill to a guest room</div>
                      <div className="flex gap-2">
                        <select
                          value={roomChargeBookingId}
                          onChange={(event) => setRoomChargeBookingId(event.target.value)}
                          disabled={selectedTableId?.startsWith(ROOM_SERVICE_PREFIX) ?? false}
                          className="flex-1 text-xs border border-neutral-300 dark:border-neutral-700 rounded bg-neutral-50 dark:bg-neutral-800 px-2 py-2 disabled:opacity-70"
                        >
                          <option value="">Select guest stay…</option>
                          {activeStays.map((booking) => (
                            <option key={booking.booking_id} value={booking.booking_id}>
                              {booking.guest_name} • Room {booking.room_number}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => void (async () => {
                            if (!selectedTableId || !roomChargeBookingId) return;
                            const result = await requestRoomCharge(selectedTableId, roomChargeBookingId);
                            setMessage(result.message);
                            if (result.success) {
                              setRoomChargeBookingId("");
                              await reloadBillHistory();
                            }
                          })()}
                          disabled={!roomChargeBookingId}
                          className="px-3 border border-neutral-300 dark:border-neutral-700 rounded text-xs font-semibold disabled:opacity-30"
                        >
                          Request approval
                        </button>
                      </div>
                      <p className="text-[10px] text-neutral-400">Call reception to approve. The bill stays open until an authorized receptionist accepts it.</p>
                    </div>
                  )}
                  {canManageSelectedTable && activeStays.length > 0 && !selectedCheck && (
                    <p className="text-[10px] text-neutral-400">
                      Save the restaurant bill before requesting a room charge.
                    </p>
                  )}
                  </>}
                  {canSettleSelectedTable && (
                    <div className="border-t border-emerald-200 dark:border-emerald-900 pt-3 space-y-3">
                      <div className="text-[10px] font-mono font-semibold uppercase text-emerald-700 dark:text-emerald-300">
                        Cashier settlement • Waiter {selectedCheck?.waiter_name}
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        {([["cash", "Cash", Banknote], ["mpesa", "M-Pesa", Smartphone], ["card", "Card", CreditCard]] as const).map(([type, label, Icon]) => (
                          <label key={type} className="space-y-1">
                            <span className="flex items-center gap-1 text-[10px] font-mono text-neutral-500"><Icon className="w-3 h-3" />{label}</span>
                            <input aria-label={`${label} received`} type="number" min="0" value={tenders[type]} onChange={(event) => setTenders({ ...tenders, [type]: event.target.value })} className="w-full px-2 py-2 text-xs font-mono border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded" />
                          </label>
                        ))}
                      </div>
                      {Number(tenders.mpesa) > 0 && (
                        <>
                          <input aria-label="M-Pesa transaction code" aria-describedby="mpesa-reference-help" value={mpesaReference} onChange={(event) => setMpesaReference(event.target.value.trim().toUpperCase())} placeholder="M-Pesa transaction code" className="w-full px-2 py-2 text-xs font-mono border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded" />
                          <p id="mpesa-reference-help" className="text-[10px] text-neutral-500">
                            The transaction must first arrive through a successful Daraja callback; a typed code alone cannot verify payment.
                          </p>
                        </>
                      )}
                      <div className={`text-xs font-mono ${settlementAmountValid ? "text-emerald-600" : "text-neutral-500"}`}>
                        Received KSh {tenderTotal.toFixed(2)} • {tenderTotal >= total ? `Change KSh ${(tenderTotal - total).toFixed(2)}` : `Due KSh ${(total - tenderTotal).toFixed(2)}`}
                      </div>
                      <button onClick={() => void submitSettle()} disabled={!settlementAmountValid || !mpesaReferenceValid || tenderTotal <= 0} className="w-full py-2.5 bg-black text-white dark:bg-white dark:text-black disabled:opacity-30 disabled:cursor-not-allowed rounded text-xs font-bold flex items-center justify-center gap-2">
                        <WalletCards className="w-4 h-4" /> Record payment & clear bill
                      </button>
                    </div>
                  )}
                  {!canManageSelectedTable && (
                    <p className="text-xs text-neutral-500">
                      {selectedCheck && selectedCheck.waiter_id !== currentUser?.id
                        ? `Order entered by waiter ${selectedCheck.waiter_name}. Only an authorized cashier can record payment here.`
                        : "Read-only restaurant access. Existing kitchen ticket status is shown above."}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {lastReceipt && (
          <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
            <div className="w-full max-w-sm bg-white dark:bg-neutral-900 border border-neutral-300 dark:border-neutral-700 rounded p-5 shadow-xl">
              <div className="flex items-start justify-between border-b border-dashed border-neutral-300 dark:border-neutral-700 pb-3">
                <div><h2 className="font-bold text-sm">KORE BENCH</h2><p className="text-[10px] font-mono text-neutral-500">Dine-in receipt • {lastReceipt.receipt_number}</p></div>
                <button onClick={clearReceipt} className="text-xs text-neutral-500">Close</button>
              </div>
              <div className="py-3 space-y-2">
                {lastReceipt.lines.map((line) => <div key={line.item.id} className="flex justify-between text-xs font-mono"><span>{line.quantity} x {line.item.name}</span><span>KSh {(line.quantity * line.item.price).toFixed(2)}</span></div>)}
              </div>
              <div className="border-t border-neutral-200 dark:border-neutral-800 pt-3 flex justify-between font-bold text-sm"><span>Total</span><span>KSh {lastReceipt.total.toFixed(2)}</span></div>
              <button onClick={() => window.print()} className="mt-4 w-full py-2 bg-black text-white dark:bg-white dark:text-black rounded text-xs font-semibold">Print receipt</button>
            </div>
          </div>
        )}
      </div>
    </DashboardShell>
  );
}
