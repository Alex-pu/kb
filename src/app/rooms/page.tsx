"use client";

import React, { useEffect, useState } from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { useTenantStore } from "@/lib/store/tenant-store";
import { Booking, HousekeepingStatus, MealAddOn, Room, RoomStatus, ShiftPeriod, TenderType } from "@/lib/types/database";
import { businessDateForCountry } from "@/lib/utils/business-date";
import { Banknote, BedDouble, Check, ChevronRight, CreditCard, Loader2, Plus, Search, Smartphone, WalletCards, X } from "lucide-react";

type RoomFilter = "all" | "needs_housekeeping" | "ready" | "occupied" | "reserved" | "maintenance";
type NewBookingForm = {
  roomId: string;
  guestName: string;
  guestPhone: string;
  checkInDate: string;
  checkOutDate: string;
  guestCount: string;
  includeBreakfast: boolean;
  breakfastRate: string;
  includeLunch: boolean;
  lunchRate: string;
};

const occupancyStatusStyles: Record<RoomStatus, string> = {
  available: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  reserved: "bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300",
  occupied: "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900",
  maintenance: "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300",
};

const housekeepingStatusStyles: Record<HousekeepingStatus, string> = {
  dirty: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  cleaning: "bg-orange-100 text-orange-800 dark:bg-orange-950/40 dark:text-orange-300",
  ready: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
};

const roomFilterOptions: { value: RoomFilter; label: string }[] = [
  { value: "all", label: "All rooms" },
  { value: "needs_housekeeping", label: "Needs cleaning" },
  { value: "ready", label: "Ready" },
  { value: "occupied", label: "Occupied" },
  { value: "reserved", label: "Reserved" },
  { value: "maintenance", label: "Maintenance" },
];

function createEmptyBooking(): NewBookingForm {
  return {
    roomId: "",
    guestName: "",
    guestPhone: "",
    checkInDate: new Date().toISOString().slice(0, 10),
    checkOutDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
    guestCount: "1",
    includeBreakfast: false,
    breakfastRate: "",
    includeLunch: false,
    lunchRate: "",
  };
}

function matchesRoomFilter(room: Room, filter: RoomFilter): boolean {
  switch (filter) {
    case "needs_housekeeping":
      return room.housekeeping_status !== "ready" && room.status !== "maintenance";
    case "ready":
      return room.status === "available" && room.housekeeping_status === "ready";
    case "occupied":
      return room.status === "occupied";
    case "reserved":
      return room.status === "reserved";
    case "maintenance":
      return room.status === "maintenance";
    default:
      return true;
  }
}

export default function RoomsPage() {
  const {
    activeProperty,
    activeOutlet,
    activeStation,
    activeReservationShift,
    currentUser,
    company,
    hasPermission,
    loadShift,
    openShift,
    closeShift,
    rooms,
    roomsLoading,
    roomTypes,
    bookings,
    folios,
    checkInBooking,
    checkOutBooking,
    postFolioCharge,
    recordFolioPayment,
    createBooking,
    loadRoomWorkspace,
    createRoomType,
    createRoom,
    roomChargeRequests,
    acceptRoomChargeRequest,
    rejectRoomChargeRequest,
  } = useTenantStore();

  const [selectedBookingId, setSelectedBookingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showNewBooking, setShowNewBooking] = useState(false);
  const [showRoomSetup, setShowRoomSetup] = useState(false);
  const [savingRoomSetup, setSavingRoomSetup] = useState(false);
  const [newRoomType, setNewRoomType] = useState({ name: "", ratePerNight: "" });
  const [newRoom, setNewRoom] = useState({ roomTypeId: "", number: "", floor: "" });
  const [chargeDesc, setChargeDesc] = useState("");
  const [chargeAmount, setChargeAmount] = useState("");
  const [tenders, setTenders] = useState<Record<TenderType, string>>({ cash: "", mpesa: "", card: "" });
  const [mpesaReference, setMpesaReference] = useState("");
  const [rejectTarget, setRejectTarget] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [approvalPromptId, setApprovalPromptId] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<{ requestId: string; message: string } | null>(null);
  const today = businessDateForCountry(company?.country_code);
  const [shiftDate, setShiftDate] = useState(today);
  const [shiftPeriod, setShiftPeriod] = useState<ShiftPeriod>("morning");
  const [openingFloat, setOpeningFloat] = useState("0");
  const [countedCash, setCountedCash] = useState("");
  const [closingShift, setClosingShift] = useState(false);
  const canOpenShift = hasPermission("shift:open");
  const canCloseShift = hasPermission("shift:close");
  const canManageFrontDesk = hasPermission("frontdesk:write");
  const canManageRoomSetup = hasPermission("rooms:manage");
  const canViewFrontDesk = hasPermission("frontdesk:read");
  const [roomSearch, setRoomSearch] = useState("");
  const [roomFilter, setRoomFilter] = useState<RoomFilter>("all");
  const [newBooking, setNewBooking] = useState<NewBookingForm>(createEmptyBooking);

  const pendingRoomCharges = roomChargeRequests.filter((r) => r.status === "pending");
  const pendingRoomChargeIds = pendingRoomCharges.map((request) => request.id).join(",");

  useEffect(() => {
    if (!canManageFrontDesk || pendingRoomCharges.length === 0) {
      setApprovalPromptId(null);
      return;
    }
    setApprovalPromptId((current) =>
      current && pendingRoomCharges.some((request) => request.id === current)
        ? current
        : pendingRoomCharges[0].id,
    );
  }, [canManageFrontDesk, pendingRoomChargeIds]);

  useEffect(() => {
    setSelectedBookingId(null);
    if (!activeProperty?.id) {
      setMessage("Select a property to load its rooms.");
      return;
    }
    void loadRoomWorkspace(activeProperty.id).then((result) => {
      if (!result.success) setMessage(result.message);
    });
  }, [activeProperty?.id, loadRoomWorkspace]);

  useEffect(() => {
    if (!activeProperty?.id || !canViewFrontDesk) return;
    const interval = window.setInterval(() => {
      void loadRoomWorkspace(activeProperty.id).then((result) => {
        if (!result.success) setMessage(result.message);
      });
    }, 5000);
    return () => window.clearInterval(interval);
  }, [activeProperty?.id, canViewFrontDesk, loadRoomWorkspace]);

  useEffect(() => {
    if (shiftDate !== today) setShiftDate(today);
  }, [shiftDate, today]);

  useEffect(() => {
    if (activeStation) void loadShift("reservation");
  }, [activeStation, loadShift]);

  useEffect(() => {
    setCountedCash("");
  }, [activeReservationShift?.id]);

  const selectedBooking = bookings.find((b) => b.id === selectedBookingId) || null;
  const selectedFolio = selectedBooking ? folios.find((f) => f.id === selectedBooking.folio_id) : null;
  const balance = (selectedFolio?.lines || []).reduce((sum, line) => sum + (line.type === "payment" ? -line.amount : line.amount), 0);
  const tenderTotal = Object.values(tenders).reduce((sum, amount) => sum + Number(amount || 0), 0);
  const normalizedRoomSearch = roomSearch.trim().toLocaleLowerCase();
  const filteredRooms = rooms.filter((room) => {
    if (!matchesRoomFilter(room, roomFilter)) return false;
    if (!normalizedRoomSearch) return true;
    const roomType = roomTypes.find((type) => type.id === room.room_type_id);
    return [room.number, room.floor, roomType?.name]
      .some((value) => value?.toLocaleLowerCase().includes(normalizedRoomSearch));
  });
  const roomGroups = [
    ...roomTypes.map((roomType) => ({
      id: roomType.id,
      name: roomType.name,
      rooms: filteredRooms.filter((room) => room.room_type_id === roomType.id),
    })),
    {
      id: "uncategorized",
      name: "Other rooms",
      rooms: filteredRooms.filter((room) => !roomTypes.some((type) => type.id === room.room_type_id)),
    },
  ].filter((group) => group.rooms.length > 0);

  const submitCloseReservationShift = async () => {
    if (!activeReservationShift || countedCash.trim() === "" || closingShift) return;
    setClosingShift(true);
    setMessage("Closing reservation shift...");
    try {
      const result = await closeShift("reservation", Number(countedCash));
      setMessage(result.message);
      if (result.success) setCountedCash("");
    } catch {
      setMessage("The reservation shift could not be closed. Please retry or contact a manager.");
    } finally {
      setClosingShift(false);
    }
  };

  const openBooking = (booking: Booking) => {
    setSelectedBookingId(booking.id);
    setMessage(null);
    setTenders({ cash: "", mpesa: "", card: "" });
    setMpesaReference("");
    setChargeDesc("");
    setChargeAmount("");
  };

  const submitPayment = async () => {
    if (!selectedFolio) return;
    const result = await recordFolioPayment(
      selectedFolio.id,
      (Object.entries(tenders) as [TenderType, string][])
        .filter(([, amount]) => Number(amount) > 0)
        .map(([type, amount]) => ({ type, amount: Number(amount), reference: type === "mpesa" ? mpesaReference : undefined })),
    );
    setMessage(result.message);
    if (result.success) {
      setTenders({ cash: "", mpesa: "", card: "" });
      setMpesaReference("");
    }
  };

  const submitCharge = async () => {
    if (!selectedFolio || !chargeDesc.trim() || Number(chargeAmount) <= 0) return;
    const result = await postFolioCharge(selectedFolio.id, chargeDesc, Number(chargeAmount));
    setMessage(result.message);
    if (result.success) {
      setChargeDesc("");
      setChargeAmount("");
    }
  };

  const submitNewBooking = async () => {
    const mealAddOns: Partial<Record<MealAddOn, number>> = {};
    if (newBooking.includeBreakfast) mealAddOns.breakfast = Number(newBooking.breakfastRate);
    if (newBooking.includeLunch) mealAddOns.lunch = Number(newBooking.lunchRate);
    const result = await createBooking({
      roomId: newBooking.roomId,
      guestName: newBooking.guestName,
      guestPhone: newBooking.guestPhone,
      checkInDate: newBooking.checkInDate,
      checkOutDate: newBooking.checkOutDate,
      guestCount: Number(newBooking.guestCount),
      mealAddOns,
    });
    setMessage(result.message);
    if (result.success) {
      setShowNewBooking(false);
      setNewBooking(createEmptyBooking());
    }
  };

  const submitRoomType = async () => {
    if (savingRoomSetup) return;
    setSavingRoomSetup(true);
    try {
      const result = await createRoomType({ name: newRoomType.name, ratePerNight: Number(newRoomType.ratePerNight) });
      setMessage(result.message);
      if (result.success) setNewRoomType({ name: "", ratePerNight: "" });
    } finally {
      setSavingRoomSetup(false);
    }
  };

  const submitRoom = async () => {
    if (savingRoomSetup) return;
    setSavingRoomSetup(true);
    try {
      const result = await createRoom(newRoom);
      setMessage(result.message);
      if (result.success) setNewRoom({ roomTypeId: "", number: "", floor: "" });
    } finally {
      setSavingRoomSetup(false);
    }
  };

  return (
    <DashboardShell>
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800 pb-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Front Desk & Rooms</h1>
            <p className="text-xs text-neutral-500 font-mono mt-0.5">Phase 4 • Live room rack, bookings, folios & housekeeping</p>
          </div>
          <div className="flex gap-2">
            {canManageRoomSetup && (
              <button onClick={() => setShowRoomSetup(true)} className="flex items-center gap-2 px-3 py-1.5 border border-neutral-300 dark:border-neutral-700 text-xs font-semibold rounded">
                <Plus className="w-3.5 h-3.5" /> Set up rooms
              </button>
            )}
            {canManageFrontDesk && (
              <button onClick={() => setShowNewBooking(true)} className="flex items-center gap-2 px-3 py-1.5 bg-black text-white dark:bg-white dark:text-black text-xs font-semibold rounded">
                <Plus className="w-3.5 h-3.5" /> New booking
              </button>
            )}
          </div>
        </div>

        {canViewFrontDesk && (
        <section className="flex flex-wrap items-center justify-between gap-3 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-3">
          <div>
            <h2 className="text-xs font-semibold">Reservation / Front Desk Shift</h2>
            <p className="text-[10px] text-neutral-500 font-mono mt-1">
              {activeReservationShift
                ? `${activeReservationShift.shift_period?.toUpperCase() ?? "LEGACY"} • ${activeReservationShift.business_date ?? "DATE N/A"}`
                : "Separate from the POS shift"}
            </p>
          </div>
          {!activeReservationShift ? (
            canOpenShift ? (
              <div className="flex flex-wrap items-center gap-2">
                <select aria-label="Reservation shift" value={shiftPeriod} onChange={(event) => setShiftPeriod(event.target.value as ShiftPeriod)} className="px-2 py-1.5 text-xs border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 rounded">
                  <option value="morning">Morning shift</option>
                  <option value="evening">Evening shift</option>
                </select>
                <input aria-label="Reservation shift business date" type="date" required min={today} max={today} value={shiftDate} onChange={(event) => setShiftDate(event.target.value)} className="px-2 py-1.5 text-xs font-mono border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 rounded" />
                <input aria-label="Reservation opening float" type="number" min="0" value={openingFloat} onChange={(event) => setOpeningFloat(event.target.value)} placeholder="Opening float" className="w-28 px-2 py-1.5 text-xs border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 rounded" />
                <button
                  type="button"
                  disabled={!activeOutlet || !activeStation || shiftDate !== today}
                  onClick={() => { void openShift("reservation", shiftPeriod, shiftDate, Number(openingFloat)).then((result) => setMessage(result.message)); }}
                  className="px-3 py-1.5 text-xs font-semibold bg-black text-white dark:bg-white dark:text-black rounded disabled:opacity-40"
                >
                  Open reservation shift
                </button>
              </div>
            ) : <span className="text-xs text-neutral-500">Only an authorized cashier can open a shift.</span>
          ) : (
            <div className="flex items-center gap-2">
              <span className="px-2 py-1 text-[10px] font-mono bg-emerald-50 text-emerald-700 border border-emerald-200 rounded">SHIFT OPEN</span>
              {activeReservationShift.cashier_id !== currentUser?.id ? (
                <span className="text-xs text-neutral-500">Only the cashier who opened this shift can close it.</span>
              ) : canCloseShift ? (
                <>
                  <label className="flex flex-col gap-0.5">
                    <span className="text-[9px] text-neutral-500">Expected KSh {(activeReservationShift.opening_float + activeReservationShift.cash_sales).toFixed(2)}</span>
                    <input aria-label="Reservation counted cash" type="number" min="0" step="0.01" value={countedCash} onChange={(event) => setCountedCash(event.target.value)} placeholder="Count actual cash" className="w-36 px-2 py-1.5 text-xs border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 rounded" />
                    <span className="text-[9px] text-neutral-500">{countedCash.trim() === "" ? "Enter the actual count to enable closing." : `Entered: KSh ${Number(countedCash).toFixed(2)}`}</span>
                  </label>
                  <button type="button" disabled={countedCash.trim() === "" || closingShift} title={countedCash.trim() === "" ? "Enter the actual cash counted in the till first." : undefined} onClick={() => void submitCloseReservationShift()} className="px-3 py-1.5 text-xs font-semibold bg-neutral-200 dark:bg-neutral-800 rounded disabled:opacity-40">
                    {closingShift ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Close shift"}
                  </button>
                </>
              ) : (
                <span className="text-xs text-neutral-500">Your role does not have permission to close shifts.</span>
              )}
            </div>
          )}
        </section>
        )}

        {message && <div role="status" className="px-3 py-2 text-xs font-mono bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded">{message}</div>}

        {canViewFrontDesk && pendingRoomCharges.length > 0 && (
          <div>
            <h2 className="text-xs font-mono font-semibold uppercase tracking-wider text-amber-600 mb-2">Pending Room Charges ({pendingRoomCharges.length})</h2>
            <div className="space-y-2">
              {pendingRoomCharges.map((request) => (
                <div key={request.id} className="flex items-center justify-between p-3 border-2 border-amber-400 bg-amber-50 dark:bg-amber-950/20 rounded">
                  <div>
                    <div className="text-xs font-semibold">{request.table_name} → {request.guest_name}</div>
                    <div className="text-[10px] font-mono text-neutral-500">KSh {request.amount.toFixed(2)} • Requested by {request.requested_by_name}</div>
                  </div>
                  {canManageFrontDesk && <div className="flex gap-2">
                    <button onClick={() => { void acceptRoomChargeRequest(request.id).then((result) => setMessage(result.message)); }} className="flex items-center gap-1 px-2.5 py-1.5 bg-black text-white dark:bg-white dark:text-black rounded text-xs font-semibold"><Check className="w-3.5 h-3.5" /> Accept</button>
                    <button onClick={() => setRejectTarget(request.id)} className="flex items-center gap-1 px-2.5 py-1.5 border border-neutral-300 dark:border-neutral-700 rounded text-xs font-semibold"><X className="w-3.5 h-3.5" /> Reject</button>
                  </div>}
                </div>
              ))}
            </div>
          </div>
        )}

        <section className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-xs font-mono font-semibold uppercase tracking-wider text-neutral-500">Room types & live availability</h2>
              <p className="mt-1 text-[10px] text-neutral-500">Expand a category to see room-by-room occupancy, readiness checks, and Front Desk notes.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <label className="relative">
                <span className="sr-only">Search rooms</span>
                <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400" />
                <input
                  type="search"
                  value={roomSearch}
                  onChange={(event) => setRoomSearch(event.target.value)}
                  placeholder="Room, floor, or type"
                  className="w-52 rounded border border-neutral-200 bg-white py-2 pl-7 pr-2 text-xs dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <label>
                <span className="sr-only">Filter rooms</span>
                <select
                  value={roomFilter}
                  onChange={(event) => setRoomFilter(event.target.value as RoomFilter)}
                  className="h-full rounded border border-neutral-200 bg-white px-2 py-2 text-xs dark:border-neutral-700 dark:bg-neutral-900"
                >
                  {roomFilterOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
            </div>
          </div>

          {roomsLoading ? (
            <div className="flex items-center justify-center gap-2 rounded border border-neutral-200 p-6 text-xs text-neutral-500 dark:border-neutral-800">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading rooms and bookings…
            </div>
          ) : rooms.length === 0 ? (
            <div className="rounded border border-dashed border-neutral-300 p-6 text-center text-xs text-neutral-500 dark:border-neutral-700">
              No rooms are configured for {activeProperty?.name || "this property"} yet.
              {canManageRoomSetup && <div className="mt-2">Create room types and add rooms to populate the live room rack.</div>}
            </div>
          ) : filteredRooms.length === 0 ? (
            <div className="rounded border border-dashed border-neutral-300 p-6 text-center text-xs text-neutral-500 dark:border-neutral-700">
              No rooms match this search and filter.
            </div>
          ) : (
            <div className="space-y-2">
              {roomGroups.map((group) => {
                const categoryRooms = group.id === "uncategorized"
                  ? rooms.filter((room) => !roomTypes.some((type) => type.id === room.room_type_id))
                  : rooms.filter((room) => room.room_type_id === group.id);
                const readyCount = categoryRooms.filter((room) => room.status === "available" && room.housekeeping_status === "ready").length;
                const occupiedCount = categoryRooms.filter((room) => room.status === "occupied").length;
                const reservedCount = categoryRooms.filter((room) => room.status === "reserved").length;
                const cleaningCount = categoryRooms.filter((room) => room.housekeeping_status === "dirty" || room.housekeeping_status === "cleaning").length;
                const maintenanceCount = categoryRooms.filter((room) => room.status === "maintenance").length;

                return (
                  <details key={group.id} className="group overflow-hidden rounded border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
                    <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 p-3 hover:bg-neutral-50 dark:hover:bg-neutral-800/40">
                      <div className="flex items-center gap-2">
                        <ChevronRight className="h-3.5 w-3.5 text-neutral-400 transition-transform group-open:rotate-90" />
                        <BedDouble className="h-4 w-4 text-neutral-400" />
                        <span className="text-sm font-semibold">{group.name}</span>
                        <span className="text-[10px] font-mono text-neutral-500">
                          {categoryRooms.length} rooms{group.rooms.length !== categoryRooms.length ? ` · ${group.rooms.length} shown` : ""}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1.5 text-[10px] font-mono">
                        <span className="rounded bg-emerald-50 px-1.5 py-1 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">{readyCount} ready</span>
                        <span className="rounded bg-neutral-100 px-1.5 py-1 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">{occupiedCount} occupied</span>
                        <span className="rounded bg-blue-50 px-1.5 py-1 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300">{reservedCount} reserved</span>
                        <span className="rounded bg-amber-50 px-1.5 py-1 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">{cleaningCount} to clean</span>
                        <span className="rounded bg-red-50 px-1.5 py-1 text-red-700 dark:bg-red-950/30 dark:text-red-300">{maintenanceCount} maintenance</span>
                      </div>
                    </summary>
                    <div className="overflow-x-auto border-t border-neutral-200 dark:border-neutral-800">
                      <table className="w-full min-w-[680px] text-left text-xs">
                        <thead className="bg-neutral-50 text-[10px] font-mono uppercase text-neutral-500 dark:bg-neutral-800/60">
                          <tr>
                            <th className="px-3 py-2">Room</th>
                            <th className="px-3 py-2">Stay / turnover</th>
                            <th className="px-3 py-2">Occupancy</th>
                            <th className="px-3 py-2">Housekeeping</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                          {group.rooms.map((room) => {
                            const activeBooking = bookings.find((booking) =>
                              booking.room_id === room.id && (booking.status === "reserved" || booking.status === "checked_in")
                            );
                            const latestCheckout = bookings
                              .filter((booking) => booking.room_id === room.id && booking.actual_check_out)
                              .sort((a, b) => new Date(b.actual_check_out!).getTime() - new Date(a.actual_check_out!).getTime())[0];
                            const stayDetail = activeBooking
                              ? `${activeBooking.status === "checked_in" ? "In house" : "Arrival"}${canViewFrontDesk ? ` · ${activeBooking.guest.full_name}` : ""}`
                              : latestCheckout?.actual_check_out
                                ? `Last checkout · ${new Date(latestCheckout.actual_check_out).toLocaleString()}`
                                : "No current stay";
                            return (
                              <tr key={room.id} className="hover:bg-neutral-50/70 dark:hover:bg-neutral-800/30">
                                <td className="px-3 py-2.5">
                                  <div className="font-semibold">{room.number}</div>
                                  <div className="text-[10px] text-neutral-500">Floor {room.floor}</div>
                                </td>
                                <td className="px-3 py-2.5 text-[11px] text-neutral-600 dark:text-neutral-400">{stayDetail}</td>
                                <td className="px-3 py-2.5">
                                  <span className={`rounded px-1.5 py-1 text-[10px] font-mono uppercase ${occupancyStatusStyles[room.status]}`}>
                                    {room.status === "available" ? "vacant" : room.status}
                                  </span>
                                </td>
                                <td className="px-3 py-2.5">
                                  <div>
                                    <span className={`rounded px-1.5 py-1 text-[10px] font-mono uppercase ${housekeepingStatusStyles[room.housekeeping_status]}`}>
                                      {room.housekeeping_status}
                                    </span>
                                    {room.housekeeping_updated_at && (
                                      <div className="mt-1 text-[9px] text-neutral-500">
                                        {new Date(room.housekeeping_updated_at).toLocaleString()}
                                        {room.housekeeping_updated_by_name ? ` · ${room.housekeeping_updated_by_name}` : ""}
                                      </div>
                                    )}
                                    {room.housekeeping_checklist && (
                                      <div className="mt-1 text-[9px] text-neutral-500">
                                        Readiness checks: {Object.values(room.housekeeping_checklist).filter(Boolean).length}/5 complete
                                      </div>
                                    )}
                                    {room.housekeeping_notes && (
                                      <div className="mt-1 max-w-48 text-[9px] text-amber-700 dark:text-amber-300">
                                        Note: {room.housekeeping_notes}
                                      </div>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </details>
                );
              })}
            </div>
          )}
        </section>

        {canViewFrontDesk && <div>
          <h2 className="text-xs font-mono font-semibold uppercase tracking-wider text-neutral-500 mb-2">Bookings & Folios</h2>
          <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded overflow-hidden">
            <table className="w-full text-left text-xs">
              <thead className="bg-neutral-50 dark:bg-neutral-800/60 text-[11px] font-mono uppercase text-neutral-500">
                <tr><th className="p-3">Guest</th><th className="p-3">Room</th><th className="p-3">Dates</th><th className="p-3">Status</th><th className="p-3">Balance</th><th className="p-3"></th></tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {bookings.map((booking) => {
                  const room = rooms.find((r) => r.id === booking.room_id);
                  const folio = folios.find((f) => f.id === booking.folio_id);
                  const bal = (folio?.lines || []).reduce((sum, line) => sum + (line.type === "payment" ? -line.amount : line.amount), 0);
                  return (
                    <tr key={booking.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-800/30 cursor-pointer" onClick={() => openBooking(booking)}>
                      <td className="p-3 font-semibold">{booking.guest.full_name}<div className="text-[10px] font-mono text-neutral-400">{booking.guest.phone_number}</div></td>
                      <td className="p-3 font-mono">{room?.number}</td>
                      <td className="p-3 font-mono text-[10px]">{new Date(booking.check_in_date).toLocaleDateString()} → {new Date(booking.check_out_date).toLocaleDateString()}</td>
                      <td className="p-3"><span className="px-1.5 py-0.5 bg-neutral-100 dark:bg-neutral-800 rounded text-[10px] font-mono uppercase">{booking.status}</span></td>
                      <td className="p-3 font-mono">KSh {bal.toFixed(2)}</td>
                      <td className="p-3 text-[10px] font-mono text-neutral-400">View →</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>}

        {selectedBooking && selectedFolio && (
          <div className="fixed inset-0 z-40 bg-black/50 flex items-center justify-end">
            <div className="w-full max-w-md h-full bg-white dark:bg-neutral-900 border-l border-neutral-300 dark:border-neutral-700 p-4 overflow-y-auto space-y-4">
              <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800 pb-3">
                <div>
                  <h2 className="font-bold text-sm">{selectedBooking.guest.full_name}</h2>
                  <p className="text-[10px] font-mono text-neutral-500">Room {rooms.find((r) => r.id === selectedBooking.room_id)?.number} • {selectedBooking.status}</p>
                </div>
                <button onClick={() => setSelectedBookingId(null)}><X className="w-4 h-4" /></button>
              </div>

              <div className="rounded border border-neutral-200 bg-neutral-50 p-2.5 text-[11px] dark:border-neutral-800 dark:bg-neutral-800/40">
                <div className="font-semibold">{selectedBooking.guest_count || 1} guest(s)</div>
                <div className="mt-1 text-neutral-500">
                  {Object.entries(selectedBooking.meal_add_ons || {}).length > 0
                    ? Object.entries(selectedBooking.meal_add_ons || {}).map(([meal, rate]) =>
                      `${meal === "breakfast" ? "Breakfast" : "Lunch"} · KSh ${Number(rate).toFixed(2)}/guest/night`
                    ).join(" • ")
                    : "Room only"}
                </div>
              </div>

              <div className="flex gap-2">
                {canManageFrontDesk && selectedBooking.status === "reserved" && (
                  <button onClick={() => { void checkInBooking(selectedBooking.id).then((result) => setMessage(result.message)); }} className="flex-1 py-2 bg-black text-white dark:bg-white dark:text-black rounded text-xs font-semibold">Check in</button>
                )}
                {canManageFrontDesk && selectedBooking.status === "checked_in" && (
                  <button
                    onClick={() => { void checkOutBooking(selectedBooking.id).then((result) => setMessage(result.message)); }}
                    disabled={balance > 0.009}
                    title={balance > 0.009 ? "Pay the guest's folio balance before checkout." : undefined}
                    className="flex-1 py-2 border border-neutral-300 dark:border-neutral-700 rounded text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {balance > 0.009 ? "Pay balance to check out" : "Check out"}
                  </button>
                )}
              </div>

              <div>
                <div className="text-[10px] font-mono font-semibold uppercase text-neutral-400 mb-2">Folio</div>
                <div className="space-y-1.5">
                  {selectedFolio.lines.map((line) => (
                    <div key={line.id} className="flex justify-between text-xs">
                      <span>{line.description}</span>
                      <span className="font-mono">{line.type === "payment" ? "-" : ""}KSh {line.amount.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
                <div className="flex justify-between text-sm font-bold border-t border-neutral-200 dark:border-neutral-800 mt-2 pt-2">
                  <span>Balance due</span><span>KSh {balance.toFixed(2)}</span>
                </div>
                {balance > 0.009 && (
                  <p role="status" className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                    Outstanding folio bills must be paid before this guest can check out.
                  </p>
                )}
              </div>

              {canManageFrontDesk && <div className="flex gap-2">
                <input value={chargeDesc} onChange={(event) => setChargeDesc(event.target.value)} placeholder="Service charge description" className="flex-1 text-xs p-2 border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded" />
                <input type="number" min="0" value={chargeAmount} onChange={(event) => setChargeAmount(event.target.value)} placeholder="Amount" className="w-24 text-xs p-2 border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded" />
                <button onClick={submitCharge} className="px-3 border border-neutral-300 dark:border-neutral-700 rounded text-xs font-semibold">Add</button>
              </div>}

              {canManageFrontDesk && balance > 0.009 && (
                <div className="space-y-3 border-t border-neutral-200 dark:border-neutral-800 pt-3">
                  <div className="text-[10px] font-mono font-semibold uppercase text-neutral-400">Record payment</div>
                  <div className="grid grid-cols-3 gap-2">
                    {([['cash', 'Cash', Banknote], ['mpesa', 'M-Pesa', Smartphone], ['card', 'Card', CreditCard]] as const).map(([type, label, Icon]) => (
                      <label key={type} className="space-y-1">
                        <span className="flex items-center gap-1 text-[10px] font-mono text-neutral-500"><Icon className="w-3 h-3" />{label}</span>
                        <input aria-label={`${label} tender`} type="number" min="0" value={tenders[type]} onChange={(event) => setTenders({ ...tenders, [type]: event.target.value })} className="w-full px-2 py-2 text-xs font-mono border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded" />
                      </label>
                    ))}
                  </div>
                  {Number(tenders.mpesa) > 0 && (
                    <input aria-label="M-Pesa reference" value={mpesaReference} onChange={(event) => setMpesaReference(event.target.value.toUpperCase())} placeholder="M-Pesa reference" className="w-full px-2 py-2 text-xs font-mono border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded" />
                  )}
                  <button onClick={submitPayment} disabled={tenderTotal <= 0} className="w-full py-2.5 bg-black text-white dark:bg-white dark:text-black disabled:opacity-30 rounded text-xs font-bold flex items-center justify-center gap-2">
                    <WalletCards className="w-4 h-4" /> Record payment
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {showRoomSetup && canManageRoomSetup && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="max-h-[90vh] w-full max-w-2xl space-y-4 overflow-y-auto rounded border border-neutral-300 bg-white p-5 dark:border-neutral-700 dark:bg-neutral-900">
              <div className="flex items-center justify-between border-b border-neutral-200 pb-3 dark:border-neutral-800">
                <div>
                  <h2 className="text-sm font-semibold">Room setup</h2>
                  <p className="mt-1 text-[10px] text-neutral-500">{activeProperty?.name || "Select a property"} · new rooms start dirty until housekeeping marks them ready</p>
                </div>
                <button type="button" onClick={() => setShowRoomSetup(false)} aria-label="Close room setup"><X className="h-4 w-4" /></button>
              </div>
              <div className="grid gap-5 md:grid-cols-2">
                <form
                  className="space-y-3"
                  onSubmit={(event) => { event.preventDefault(); void submitRoomType(); }}
                >
                  <h3 className="text-xs font-semibold">Create room type</h3>
                  <label className="block space-y-1 text-xs">Category name
                    <input
                      required
                      maxLength={100}
                      value={newRoomType.name}
                      onChange={(event) => setNewRoomType({ ...newRoomType, name: event.target.value })}
                      placeholder="e.g. Deluxe Single"
                      className="w-full rounded border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-700 dark:bg-neutral-800"
                    />
                  </label>
                  <label className="block space-y-1 text-xs">Rate per night (KSh)
                    <input
                      required
                      type="number"
                      min="0.01"
                      max="1000000"
                      step="0.01"
                      value={newRoomType.ratePerNight}
                      onChange={(event) => setNewRoomType({ ...newRoomType, ratePerNight: event.target.value })}
                      className="w-full rounded border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-700 dark:bg-neutral-800"
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={savingRoomSetup || !newRoomType.name.trim() || Number(newRoomType.ratePerNight) <= 0}
                    className="w-full rounded bg-black py-2 text-xs font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-black"
                  >
                    {savingRoomSetup ? "Saving…" : "Create room type"}
                  </button>
                </form>

                <form
                  className="space-y-3 border-t border-neutral-200 pt-4 dark:border-neutral-800 md:border-l md:border-t-0 md:pl-5 md:pt-0"
                  onSubmit={(event) => { event.preventDefault(); void submitRoom(); }}
                >
                  <h3 className="text-xs font-semibold">Add individual room</h3>
                  <label className="block space-y-1 text-xs">Room type
                    <select
                      required
                      value={newRoom.roomTypeId}
                      onChange={(event) => setNewRoom({ ...newRoom, roomTypeId: event.target.value })}
                      className="w-full rounded border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-700 dark:bg-neutral-800"
                    >
                      <option value="">Select a category</option>
                      {roomTypes.map((roomType) => <option key={roomType.id} value={roomType.id}>{roomType.name}</option>)}
                    </select>
                  </label>
                  <label className="block space-y-1 text-xs">Room number
                    <input
                      required
                      maxLength={30}
                      value={newRoom.number}
                      onChange={(event) => setNewRoom({ ...newRoom, number: event.target.value })}
                      placeholder="e.g. 101"
                      className="w-full rounded border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-700 dark:bg-neutral-800"
                    />
                  </label>
                  <label className="block space-y-1 text-xs">Floor / building
                    <input
                      required
                      maxLength={40}
                      value={newRoom.floor}
                      onChange={(event) => setNewRoom({ ...newRoom, floor: event.target.value })}
                      placeholder="e.g. 1"
                      className="w-full rounded border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-700 dark:bg-neutral-800"
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={savingRoomSetup || roomTypes.length === 0 || !newRoom.roomTypeId || !newRoom.number.trim() || !newRoom.floor.trim()}
                    className="w-full rounded bg-black py-2 text-xs font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-black"
                  >
                    {savingRoomSetup ? "Saving…" : "Add room"}
                  </button>
                </form>
              </div>
            </div>
          </div>
        )}

        {showNewBooking && canManageFrontDesk && (
          <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
            <div className="w-full max-w-md bg-white dark:bg-neutral-900 border border-neutral-300 dark:border-neutral-700 rounded p-5 space-y-3">
              <div className="flex justify-between items-center"><h2 className="font-semibold text-sm">New booking</h2><button onClick={() => setShowNewBooking(false)}><X className="w-4 h-4" /></button></div>
              <label className="block text-xs space-y-1">Room
                <select value={newBooking.roomId} onChange={(event) => setNewBooking({ ...newBooking, roomId: event.target.value })} className="w-full p-2 border rounded bg-neutral-50 dark:bg-neutral-800">
                  <option value="">Select a room</option>
                  {rooms.filter((room) => room.status === "available" && room.housekeeping_status === "ready").map((room) => (
                    <option key={room.id} value={room.id}>{room.number} • {roomTypes.find((rt) => rt.id === room.room_type_id)?.name}</option>
                  ))}
                </select>
              </label>
              <label className="block text-xs space-y-1">Guest name<input value={newBooking.guestName} onChange={(event) => setNewBooking({ ...newBooking, guestName: event.target.value })} className="w-full p-2 border rounded bg-neutral-50 dark:bg-neutral-800" /></label>
              <label className="block text-xs space-y-1">Guest phone<input value={newBooking.guestPhone} onChange={(event) => setNewBooking({ ...newBooking, guestPhone: event.target.value })} className="w-full p-2 border rounded bg-neutral-50 dark:bg-neutral-800" /></label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-xs space-y-1">Check-in<input type="date" value={newBooking.checkInDate} onChange={(event) => setNewBooking({ ...newBooking, checkInDate: event.target.value })} className="w-full p-2 border rounded bg-neutral-50 dark:bg-neutral-800" /></label>
                <label className="block text-xs space-y-1">Check-out<input type="date" value={newBooking.checkOutDate} onChange={(event) => setNewBooking({ ...newBooking, checkOutDate: event.target.value })} className="w-full p-2 border rounded bg-neutral-50 dark:bg-neutral-800" /></label>
              </div>
              <label className="block text-xs space-y-1">Number of guests
                <input type="number" min="1" step="1" value={newBooking.guestCount} onChange={(event) => setNewBooking({ ...newBooking, guestCount: event.target.value })} className="w-full p-2 border rounded bg-neutral-50 dark:bg-neutral-800" />
              </label>
              <div className="space-y-2 rounded border border-neutral-200 p-3 dark:border-neutral-700">
                <div className="text-[10px] font-mono font-semibold uppercase text-neutral-500">Meal add-ons · per guest / night</div>
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={newBooking.includeBreakfast} onChange={(event) => setNewBooking({ ...newBooking, includeBreakfast: event.target.checked })} />
                  Breakfast
                </label>
                {newBooking.includeBreakfast && (
                  <label className="block space-y-1 text-[11px]">Breakfast rate (KSh)
                    <input type="number" min="0.01" step="0.01" required value={newBooking.breakfastRate} onChange={(event) => setNewBooking({ ...newBooking, breakfastRate: event.target.value })} placeholder="Rate per guest, per night" className="w-full p-2 border rounded bg-neutral-50 dark:bg-neutral-800" />
                  </label>
                )}
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={newBooking.includeLunch} onChange={(event) => setNewBooking({ ...newBooking, includeLunch: event.target.checked })} />
                  Lunch
                </label>
                {newBooking.includeLunch && (
                  <label className="block space-y-1 text-[11px]">Lunch rate (KSh)
                    <input type="number" min="0.01" step="0.01" required value={newBooking.lunchRate} onChange={(event) => setNewBooking({ ...newBooking, lunchRate: event.target.value })} placeholder="Rate per guest, per night" className="w-full p-2 border rounded bg-neutral-50 dark:bg-neutral-800" />
                  </label>
                )}
              </div>
              <button
                onClick={submitNewBooking}
                disabled={
                  !newBooking.roomId ||
                  !newBooking.guestName.trim() ||
                  !newBooking.guestPhone.trim() ||
                  !Number.isInteger(Number(newBooking.guestCount)) ||
                  Number(newBooking.guestCount) < 1 ||
                  newBooking.checkOutDate <= newBooking.checkInDate ||
                  (newBooking.includeBreakfast && Number(newBooking.breakfastRate) <= 0) ||
                  (newBooking.includeLunch && Number(newBooking.lunchRate) <= 0)
                }
                className="w-full py-2 bg-black text-white dark:bg-white dark:text-black rounded text-xs font-semibold disabled:opacity-30"
              >
                Create booking
              </button>
            </div>
          </div>
        )}

        {rejectTarget && canManageFrontDesk && (
          <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
            <div className="w-full max-w-sm bg-white dark:bg-neutral-900 border border-neutral-300 dark:border-neutral-700 rounded p-5 space-y-3">
              <h2 className="font-semibold text-sm">Reject room charge</h2>
              <p className="text-xs text-neutral-500">A reason is required for the audit trail.</p>
              <input autoFocus value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} placeholder="e.g. Guest name mismatch" className="w-full p-2 text-xs border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded" />
              <div className="flex gap-2">
                <button onClick={() => { setRejectTarget(null); setRejectReason(""); }} className="flex-1 py-2 border border-neutral-300 dark:border-neutral-700 rounded text-xs font-semibold">Back</button>
                <button
                  onClick={() => void (async () => {
                    const result = await rejectRoomChargeRequest(rejectTarget, rejectReason);
                    setMessage(result.message);
                    if (result.success) {
                      setRejectTarget(null);
                      setRejectReason("");
                      setApprovalPromptId(null);
                    }
                  })()}
                  disabled={!rejectReason.trim()}
                  className="flex-1 py-2 bg-black text-white dark:bg-white dark:text-black rounded text-xs font-semibold disabled:opacity-30"
                >
                  Confirm reject
                </button>
              </div>
            </div>
          </div>
        )}

        {approvalPromptId && canManageFrontDesk && !rejectTarget && (() => {
          const request = pendingRoomCharges.find((item) => item.id === approvalPromptId);
          if (!request) return null;
          return (
            <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="room-charge-approval-title">
              <div className="w-full max-w-md bg-white dark:bg-neutral-900 border-2 border-amber-400 rounded p-5 shadow-xl space-y-4">
                <div>
                  <h2 id="room-charge-approval-title" className="font-semibold text-sm">Restaurant room-charge approval</h2>
                  <p className="mt-1 text-xs text-neutral-500">The waiter is waiting for reception to approve this bill.</p>
                </div>
                <div className="rounded border border-neutral-200 dark:border-neutral-700 p-3 space-y-1 text-xs">
                  <div className="font-semibold">{request.table_name} → {request.guest_name}</div>
                  <div className="text-neutral-500">KSh {request.amount.toFixed(2)} • Requested by {request.requested_by_name}</div>
                </div>
                {approvalError?.requestId === request.id && (
                  <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
                    {approvalError.message}
                  </p>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={() => setApprovalPromptId(null)}
                    className="flex-1 py-2 border border-neutral-300 dark:border-neutral-700 rounded text-xs font-semibold"
                  >
                    Review later
                  </button>
                  <button
                    onClick={() => { setRejectTarget(request.id); setApprovalPromptId(null); }}
                    className="flex-1 py-2 border border-red-300 text-red-700 dark:text-red-300 rounded text-xs font-semibold"
                  >
                    Reject
                  </button>
                  <button
                    onClick={() => void acceptRoomChargeRequest(request.id).then((result) => {
                      setMessage(result.message);
                      if (result.success) {
                        setApprovalPromptId(null);
                        setApprovalError(null);
                      } else {
                        setApprovalError({ requestId: request.id, message: result.message });
                      }
                    })}
                    className="flex-1 py-2 bg-black text-white dark:bg-white dark:text-black rounded text-xs font-semibold"
                  >
                    Approve
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      </div>
    </DashboardShell>
  );
}
