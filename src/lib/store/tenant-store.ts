import { create } from "zustand";
import { CatalogItem, CartLine, ChartOfAccount, Company, DarajaPaymentRecord, DarajaShopConfig, Expense, FloorArea, Folio, Booking, HousekeepingStatus, JournalEntry, JournalLine, Kot, KotStatus, MealAddOn, Outlet, Property, Room, RoomType, RestaurantTable, RetailReceipt, RetailShift, Role, RoomChargeRequest, ApprovalPolicy, ShiftArea, ShiftPeriod, Station, StockItem, StockMovement, StockRequisition, TableOrderLine, TenderLine, User, UserAssignment } from "../types/database";
import { enqueueOfflineOperation } from "../offline/offline-queue";
import { permissionGranted } from "../auth/permissions";

interface RestaurantCheckInfo {
  id: string;
  bill_number: string;
  table_name: string;
  shift_id: string;
  cashier_id: string;
  cashier_name: string;
  waiter_id: string;
  waiter_name: string;
  callback_transaction_code?: string | null;
}

interface RestaurantBillRecord {
  id: string;
  bill_number: string;
  waiter_id: string;
  waiter_name: string;
  cashier_name: string;
  table_id: string;
  table_name: string;
  business_date: string;
  shift_period: ShiftPeriod | null;
  status: "open" | "settled" | "voided";
  room_charge_pending: boolean;
  room_charge_request_id: string | null;
  room_charge_guest_name: string | null;
  payments: Array<{ type: string; amount: number; reference: string | null }>;
  lines: TableOrderLine[];
  total: number;
  created_at: string;
  settled_at: string | null;
  kitchen_tickets: Array<{ station: "kitchen" | "bar"; round: number; status: KotStatus }>;
  etims_status: "pending" | "submitted" | "failed" | "blocked" | "unknown" | null;
  etims_invoice_number: string | null;
  etims_scdc_id: string | null;
  etims_signature: string | null;
  etims_receipt_date: string | null;
  etims_receipt_number: string | null;
  etims_verification_url: string | null;
  etims_customer_tin: string | null;
  etims_customer_name: string | null;
  etims_error: string | null;
}

interface RestaurantChecksPayload {
  success: boolean;
  message?: string;
  menu: CatalogItem[];
  checks: Array<RestaurantCheckInfo & {
    table_id: string;
    bill_number: string;
    table_name: string;
    lines: TableOrderLine[];
    total: number;
  }>;
}

interface RestaurantCheckMutationResult {
  success: boolean;
  message: string;
  check_id?: string;
  bill_number?: string;
  total?: number;
  shift_id?: string;
  cashier_id?: string;
  cashier_name?: string;
  waiter_id?: string;
  waiter_name?: string;
  kots?: Kot[];
}

interface KotApiResult {
  success: boolean;
  message?: string;
  tickets?: Kot[];
  ticket?: Kot;
}

interface RestaurantBillsPayload {
  success: boolean;
  message?: string;
  bills?: RestaurantBillRecord[];
}

interface StockWorkspacePayload {
  success: boolean;
  message?: string;
  items?: StockItem[];
  movements?: StockMovement[];
  requisitions?: StockRequisition[];
}

interface RoomWorkspacePayload {
  success: boolean;
  message?: string;
  roomTypes?: RoomType[];
  rooms?: Room[];
  bookings?: Booking[];
  folios?: Folio[];
  roomChargeRequests?: RoomChargeRequest[];
}

interface RoomApiResult {
  success: boolean;
  message: string;
}

async function postRoomAction(body: Record<string, unknown>): Promise<RoomApiResult> {
  try {
    const response = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null ||
        !("success" in value) || typeof value.success !== "boolean" ||
        !("message" in value) || typeof value.message !== "string") {
      return { success: false, message: "The server returned an invalid room-operation response." };
    }
    return response.ok ? value as RoomApiResult : { ...value, success: false } as RoomApiResult;
  } catch {
    return { success: false, message: "Could not confirm the room change. Refresh the room workspace before retrying." };
  }
}

async function postRestaurantRoomCharge(body: Record<string, unknown>): Promise<RoomApiResult> {
  try {
    const response = await fetch("/api/restaurant/room-charges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null ||
        !("success" in value) || typeof value.success !== "boolean" ||
        !("message" in value) || typeof value.message !== "string") {
      return { success: false, message: "The server returned an invalid room-charge response." };
    }
    return response.ok ? value as RoomApiResult : { ...value, success: false } as RoomApiResult;
  } catch {
    return { success: false, message: "Could not reach the server. The room-charge request was not confirmed." };
  }
}

const restaurantMutationQueues = new Map<string, Promise<void>>();
let roomWorkspaceRequestSequence = 0;

function serializeRestaurantMutation<T>(tableId: string, operation: () => Promise<T>): Promise<T> {
  const previous = restaurantMutationQueues.get(tableId) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  restaurantMutationQueues.set(tableId, result.then(() => undefined, () => undefined));
  return result;
}

async function postRestaurantCheck(body: Record<string, unknown>): Promise<RestaurantCheckMutationResult> {
  try {
    const response = await fetch("/api/restaurant/checks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || !("success" in value) || !("message" in value)) {
      return { success: false, message: "The server returned an invalid restaurant-check response." };
    }
    const result = value as RestaurantCheckMutationResult;
    return response.ok ? result : { ...result, success: false };
  } catch {
    return { success: false, message: "Could not reach the server. The restaurant bill was not changed." };
  }
}

const DINING_PROPERTY_ID = "22222222-2222-2222-2222-222222222222";
const DINING_OUTLET_ID = "44444444-4444-4444-4444-444444444444";

export const MOCK_FLOOR_AREAS: FloorArea[] = [
  { id: "area-001", property_id: DINING_PROPERTY_ID, outlet_id: DINING_OUTLET_ID, name: "Main Dining" },
  { id: "area-002", property_id: DINING_PROPERTY_ID, outlet_id: DINING_OUTLET_ID, name: "Garden Terrace" },
  { id: "area-003", property_id: DINING_PROPERTY_ID, outlet_id: DINING_OUTLET_ID, name: "Bar Counter" },
];

export const MOCK_TABLES: RestaurantTable[] = [
  { id: "table-01", floor_area_id: "area-001", outlet_id: DINING_OUTLET_ID, property_id: DINING_PROPERTY_ID, name: "T1", capacity: 4, status: "available" },
  { id: "table-02", floor_area_id: "area-001", outlet_id: DINING_OUTLET_ID, property_id: DINING_PROPERTY_ID, name: "T2", capacity: 2, status: "available" },
  { id: "table-03", floor_area_id: "area-001", outlet_id: DINING_OUTLET_ID, property_id: DINING_PROPERTY_ID, name: "T3", capacity: 6, status: "available" },
  { id: "table-04", floor_area_id: "area-002", outlet_id: DINING_OUTLET_ID, property_id: DINING_PROPERTY_ID, name: "T4", capacity: 4, status: "available" },
  { id: "table-05", floor_area_id: "area-002", outlet_id: DINING_OUTLET_ID, property_id: DINING_PROPERTY_ID, name: "T5", capacity: 4, status: "available" },
  { id: "table-06", floor_area_id: "area-003", outlet_id: DINING_OUTLET_ID, property_id: DINING_PROPERTY_ID, name: "B1", capacity: 2, status: "available" },
];

export const MOCK_MENU: CatalogItem[] = [
  { id: "menu-001", property_id: DINING_PROPERTY_ID, outlet_id: DINING_OUTLET_ID, name: "Nyama Choma Platter", sku: "FOOD-NCP", category: "food", price: 1200, stock: 0, reorder_level: 0, stock_tracked: false, is_active: true, prep_station: "kitchen" },
  { id: "menu-002", property_id: DINING_PROPERTY_ID, outlet_id: DINING_OUTLET_ID, name: "Grilled Tilapia", sku: "FOOD-TIL", category: "food", price: 950, stock: 0, reorder_level: 0, stock_tracked: false, is_active: true, prep_station: "kitchen" },
  { id: "menu-003", property_id: DINING_PROPERTY_ID, outlet_id: DINING_OUTLET_ID, name: "Ugali & Sukuma Wiki", sku: "FOOD-UGS", category: "food", price: 350, stock: 0, reorder_level: 0, stock_tracked: false, is_active: true, prep_station: "kitchen" },
  { id: "menu-004", property_id: DINING_PROPERTY_ID, outlet_id: DINING_OUTLET_ID, name: "Tusker Lager 500ml", sku: "BEV-TUSK", category: "beverage", price: 300, stock: 0, reorder_level: 0, stock_tracked: false, is_active: true, prep_station: "bar" },
  { id: "menu-005", property_id: DINING_PROPERTY_ID, outlet_id: DINING_OUTLET_ID, name: "Fresh Passion Juice", sku: "BEV-PJU", category: "beverage", price: 250, stock: 0, reorder_level: 0, stock_tracked: false, is_active: true, prep_station: "bar" },
];

const KOT_LEGAL_TRANSITIONS: Record<KotStatus, KotStatus[]> = {
  new: ["accepted", "cancelled"],
  accepted: ["preparing", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["served"],
  served: [],
  cancelled: [],
};

export const MOCK_APPROVAL_POLICIES: ApprovalPolicy[] = [
  { id: "policy-discount", action_type: "discount", label: "Discount requires approval above", threshold: 10, required_role: "general_manager" },
  { id: "policy-void", action_type: "void", label: "Void requires approval above (KES)", threshold: 1000, required_role: "general_manager" },
  { id: "policy-refund", action_type: "refund", label: "Refund requires approval above (KES)", threshold: 1000, required_role: "general_manager" },
  { id: "policy-variance", action_type: "shift_variance", label: "Shift variance requires manager sign-off above (KES)", threshold: 500, required_role: "general_manager" },
  { id: "policy-room-charge", action_type: "room_charge_signoff", label: "Room charge sign-off required from", threshold: 0, required_role: "receptionist" },
];

// Account IDs referenced by auto-posting logic below.
const ACCT_CASH = "acct-1000";
const ACCT_MPESA = "acct-1010";
const ACCT_CARD_CLEARING = "acct-1020";
const ACCT_ACCOUNTS_RECEIVABLE = "acct-1100";
const ACCT_INVENTORY = "acct-1200";
const ACCT_SALES_REVENUE = "acct-4000";
const ACCT_ROOM_REVENUE = "acct-4010";
const ACCT_OPERATING_EXPENSE = "acct-5000";

export const MOCK_CHART_OF_ACCOUNTS: ChartOfAccount[] = [
  { id: ACCT_CASH, code: "1000", name: "Cash on Hand", type: "asset" },
  { id: ACCT_MPESA, code: "1010", name: "M-Pesa Till", type: "asset" },
  { id: ACCT_CARD_CLEARING, code: "1020", name: "Card Clearing Account", type: "asset" },
  { id: ACCT_ACCOUNTS_RECEIVABLE, code: "1100", name: "Guest Folios Receivable", type: "asset" },
  { id: ACCT_INVENTORY, code: "1200", name: "Inventory", type: "asset" },
  { id: "acct-2100", code: "2100", name: "Accounts Payable", type: "liability" },
  { id: "acct-3000", code: "3000", name: "Owner's Equity", type: "equity" },
  { id: ACCT_SALES_REVENUE, code: "4000", name: "Retail & Dining Sales Revenue", type: "revenue" },
  { id: ACCT_ROOM_REVENUE, code: "4010", name: "Room Revenue", type: "revenue" },
  { id: ACCT_OPERATING_EXPENSE, code: "5000", name: "Operating Expenses", type: "expense" },
  { id: "acct-5100", code: "5100", name: "Cost of Goods Sold", type: "expense" },
];

function buildJournalEntry(
  entryNumber: string,
  description: string,
  sourceType: JournalEntry["source_type"],
  sourceId: string | undefined,
  lines: JournalLine[],
): JournalEntry | null {
  const totalDebit = lines.reduce((sum, line) => sum + line.debit, 0);
  const totalCredit = lines.reduce((sum, line) => sum + line.credit, 0);
  if (Math.abs(totalDebit - totalCredit) > 0.009) return null;
  return {
    id: `je-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    entry_number: entryNumber,
    date: new Date().toISOString(),
    description,
    source_type: sourceType,
    source_id: sourceId,
    lines,
    is_reversed: false,
    created_at: new Date().toISOString(),
  };
}

function hasRolePermission(role: Role | null, permission: string): boolean {
  return !!role && permissionGranted(role.permissions, permission);
}

function tenderAccount(tenderType: TenderLine["type"]): string {
  if (tenderType === "mpesa") return ACCT_MPESA;
  if (tenderType === "card") return ACCT_CARD_CLEARING;
  return ACCT_CASH;
}

interface UserBundleResponse {
  user: User;
  company: Company;
  assignments: UserAssignment[];
  properties: Property[];
  outlets: Outlet[];
  stations: Station[];
  roles: Role[];
}

/** Maps a `/api/auth/login` or `/api/auth/me` response onto the store's identity/scope fields. */
function applyUserBundle(set: (partial: Partial<TenantState>) => void, data: UserBundleResponse) {
  roomWorkspaceRequestSequence += 1;
  const activeProperty = data.properties[0] ?? null;
  const availableOutlets = activeProperty ? data.outlets.filter((o) => o.property_id === activeProperty.id) : [];
  const activeOutlet = availableOutlets[0] ?? null;
  const availableStations = activeOutlet ? data.stations.filter((s) => s.outlet_id === activeOutlet.id) : [];
  const activeStation = availableStations[0] ?? null;
  const currentAssignment = activeProperty
    ? data.assignments.find((a) => a.property_id === activeProperty.id) ?? data.assignments[0] ?? null
    : data.assignments[0] ?? null;
  const activeRole = currentAssignment?.role ?? (currentAssignment ? data.roles.find((r) => r.id === currentAssignment.role_id) ?? null : null);

  set({
    company: data.company,
    currentUser: data.user,
    isAuthenticated: true,
    authLoading: false,
    authError: null,
    userAssignments: data.assignments,
    availableProperties: data.properties,
    activeProperty,
    allOutlets: data.outlets,
    allStations: data.stations,
    availableOutlets,
    activeOutlet,
    availableStations,
    activeStation,
    activeRole,
    activeAssignment: currentAssignment,
    menu: [],
    tableOrders: {},
    tableRounds: {},
    restaurantChecks: {},
    restaurantBills: [],
    kots: [],
    roomTypes: [],
    rooms: [],
    roomsLoading: false,
    roomWorkspacePropertyId: null,
    bookings: [],
    folios: [],
  });
}

interface TenantState {
  company: Company | null;
  currentUser: User | null;
  isAuthenticated: boolean;
  authLoading: boolean;
  authError: string | null;
  userAssignments: UserAssignment[];
  availableProperties: Property[];
  activeProperty: Property | null;
  // Full outlet/station universe for the signed-in user (across all their
  // assigned properties) — switchProperty/switchOutlet filter these instead
  // of any hardcoded mock data.
  allOutlets: Outlet[];
  allStations: Station[];
  availableOutlets: Outlet[];
  activeOutlet: Outlet | null;
  availableStations: Station[];
  activeStation: Station | null;
  activeRole: Role | null;
  activeAssignment: UserAssignment | null;
  catalog: CatalogItem[];
  catalogLoading: boolean;
  cart: CartLine[];
  activeShift: RetailShift | null;
  activeReservationShift: RetailShift | null;
  lastCheckoutKey: string | null;
  lastReceipt: RetailReceipt | null;
  floorAreas: FloorArea[];
  tables: RestaurantTable[];
  menu: CatalogItem[];
  tableOrders: Record<string, TableOrderLine[]>;
  tableRounds: Record<string, number>;
  restaurantChecks: Record<string, RestaurantCheckInfo>;
  restaurantBills: RestaurantBillRecord[];
  kots: Kot[];
  roomTypes: RoomType[];
  rooms: Room[];
  roomsLoading: boolean;
  roomWorkspacePropertyId: string | null;
  bookings: Booking[];
  folios: Folio[];
  roomChargeRequests: RoomChargeRequest[];
  approvalPolicies: ApprovalPolicy[];
  stockItems: StockItem[];
  stockLevels: Record<string, Record<string, number>>;
  stockMovements: StockMovement[];
  stockRequisitions: StockRequisition[];
  chartOfAccounts: ChartOfAccount[];
  journalEntries: JournalEntry[];
  expenses: Expense[];
  darajaConfigs: DarajaShopConfig[];
  pendingMpesaPayments: DarajaPaymentRecord[];

  // Actions
  login: (identifier: string, credential: string, method?: "password" | "pin") => Promise<{ success: boolean; message: string }>;
  logout: () => Promise<void>;
  hydrateSession: () => Promise<void>;
  hasPermission: (permission: string) => boolean;
  switchProperty: (propertyId: string) => void;
  switchOutlet: (outletId: string) => void;
  switchStation: (stationId: string) => void;
  loadCatalog: () => Promise<void>;
  loadStockWorkspace: () => Promise<{ success: boolean; message: string }>;
  loadRestaurantChecks: () => Promise<{ success: boolean; message: string }>;
  loadRestaurantKots: () => Promise<{ success: boolean; message: string }>;
  loadRestaurantBills: (businessDate: string) => Promise<{ success: boolean; message: string }>;
  addToCart: (item: CatalogItem) => void;
  updateCartQuantity: (itemId: string, quantity: number) => void;
  clearCart: () => void;
  loadShift: (area: ShiftArea) => Promise<{ success: boolean; message: string }>;
  openShift: (area: ShiftArea, period: ShiftPeriod, businessDate: string, openingFloat: number) => Promise<{ success: boolean; message: string }>;
  closeShift: (area: ShiftArea, countedCash: number) => Promise<{ success: boolean; message: string }>;
  checkout: (tenders: TenderLine[], idempotencyKey: string) => Promise<{ success: boolean; message: string }>;
  clearReceipt: () => void;
  addCatalogItem: (input: Pick<CatalogItem, "name" | "price" | "category"> & {
    item_type: "retail" | "supply";
    unit: string;
    initial_stock_kitchen: number;
    initial_stock_bar: number;
    reorder_level: number;
    stock_tracked: boolean;
    prep_station: "kitchen" | "bar";
    digitax_template_id: string;
  }) => Promise<{ success: boolean; message: string }>;
  addItemToTable: (tableId: string, item: CatalogItem) => Promise<{ success: boolean; message: string }>;
  updateTableItemQuantity: (tableId: string, itemId: string, quantity: number, round: number) => Promise<{ success: boolean; message: string }>;
  updateTableLineInstructions: (tableId: string, itemId: string, round: number, instructions: string) => Promise<{ success: boolean; message: string }>;
  sendRoundToKitchen: (tableId: string) => Promise<{ success: boolean; message: string }>;
  transitionKot: (kotId: string, nextStatus: KotStatus, reason?: string) => Promise<{ success: boolean; message: string }>;
  requestBill: (tableId: string) => void;
  settleTable: (tableId: string, tenders: TenderLine[], idempotencyKey: string) => Promise<{ success: boolean; message: string }>;
  markTableAvailable: (tableId: string) => void;
  transferTableOrder: (fromTableId: string, toTableId: string) => { success: boolean; message: string };
  loadRoomWorkspace: (propertyId: string) => Promise<{ success: boolean; message: string }>;
  createRoomType: (input: { name: string; ratePerNight: number }) => Promise<{ success: boolean; message: string }>;
  createRoom: (input: { roomTypeId: string; number: string; floor: string }) => Promise<{ success: boolean; message: string }>;
  checkInBooking: (bookingId: string) => Promise<{ success: boolean; message: string }>;
  checkOutBooking: (bookingId: string) => Promise<{ success: boolean; message: string }>;
  postFolioCharge: (folioId: string, description: string, amount: number) => Promise<{ success: boolean; message: string }>;
  recordFolioPayment: (folioId: string, tenders: TenderLine[]) => Promise<{ success: boolean; message: string }>;
  createBooking: (input: {
    roomId: string;
    guestName: string;
    guestPhone: string;
    checkInDate: string;
    checkOutDate: string;
    guestCount: number;
    mealAddOns: Partial<Record<MealAddOn, number>>;
  }) => Promise<{ success: boolean; message: string }>;
  requestRoomCharge: (tableId: string, bookingId: string) => Promise<{ success: boolean; message: string }>;
  acceptRoomChargeRequest: (requestId: string) => Promise<{ success: boolean; message: string }>;
  rejectRoomChargeRequest: (requestId: string, reason: string) => Promise<{ success: boolean; message: string }>;
  updateApprovalPolicy: (policyId: string, threshold: number) => void;
  recordExpense: (description: string, amount: number, accountId: string, category: string) => { success: boolean; message: string };
  postManualJournalEntry: (description: string, lines: JournalLine[]) => { success: boolean; message: string };
  reverseJournalEntry: (entryId: string) => { success: boolean; message: string };
  saveDarajaConfig: (config: Partial<DarajaShopConfig> & { property_id?: string; outlet_id?: string }) => { success: boolean; message: string };
  registerMpesaPayment: (input: { property_id: string; outlet_id?: string; order_id: string; bill_reference?: string; amount: number; transaction_code: string; payer_phone?: string; }) => { success: boolean; message: string; payment?: DarajaPaymentRecord };
  confirmManualMpesaPayment: (input: { property_id: string; outlet_id?: string; order_id: string; bill_reference?: string; amount: number; transaction_code: string; payer_phone?: string }) => { success: boolean; message: string; payment?: DarajaPaymentRecord };
  processDarajaCallback: (input: { property_id: string; outlet_id?: string; amount: number; transaction_code: string; status: "paid" | "failed" | "timeout"; payer_phone?: string; bill_reference?: string; order_id?: string; callback_payload?: Record<string, unknown> }) => { success: boolean; message: string; payment?: DarajaPaymentRecord };
}

async function completeRoomAction(
  get: () => TenantState,
  propertyId: string,
  action: string,
  fields: Record<string, unknown>,
): Promise<RoomApiResult> {
  const result = await postRoomAction({ property_id: propertyId, action, ...fields });
  if (!result.success) return result;
  const refreshed = await get().loadRoomWorkspace(propertyId);
  return refreshed.success
    ? result
    : { success: true, message: `${result.message} The change was saved, but the room list could not refresh: ${refreshed.message}` };
}

export const useTenantStore = create<TenantState>()(
  (set, get) => ({
      company: null,
      currentUser: null,
      isAuthenticated: false,
      authLoading: true,
      authError: null,
      userAssignments: [],
      availableProperties: [],
      activeProperty: null,
      allOutlets: [],
      allStations: [],
      availableOutlets: [],
      activeOutlet: null,
      availableStations: [],
      activeStation: null,
      activeRole: null,
      activeAssignment: null,
      catalog: [],
      catalogLoading: false,
      cart: [],
      activeShift: null,
      activeReservationShift: null,
      lastCheckoutKey: null,
      lastReceipt: null,
      floorAreas: MOCK_FLOOR_AREAS,
      tables: MOCK_TABLES,
      menu: [],
      tableOrders: {},
      tableRounds: {},
      restaurantChecks: {},
      restaurantBills: [],
      kots: [],
      roomTypes: [],
      rooms: [],
      roomsLoading: false,
      roomWorkspacePropertyId: null,
      bookings: [],
      folios: [],
      roomChargeRequests: [],
      approvalPolicies: MOCK_APPROVAL_POLICIES,
      stockItems: [],
      stockLevels: {},
      stockMovements: [],
      stockRequisitions: [],
      chartOfAccounts: MOCK_CHART_OF_ACCOUNTS,
      journalEntries: [],
      expenses: [],
      darajaConfigs: [],
      pendingMpesaPayments: [],

      hydrateSession: async () => {
        set({ authLoading: true });
        try {
          const res = await fetch("/api/auth/me", { credentials: "include" });
          if (!res.ok) {
            set({ authLoading: false, isAuthenticated: false });
            return;
          }
          const data = await res.json();
          applyUserBundle(set, data);
          void get().loadCatalog();
        } catch {
          set({ authLoading: false, isAuthenticated: false });
        }
      },

      login: async (identifier: string, credential: string, method: "password" | "pin" = "password") => {
        set({ authLoading: true, authError: null });
        try {
          const res = await fetch("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ identifier, [method]: credential }),
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            set({ authLoading: false, isAuthenticated: false, authError: data.message || "Sign-in failed." });
            return { success: false, message: data.message || "Sign-in failed." };
          }
          applyUserBundle(set, data);
          void get().loadCatalog();
          return { success: true, message: "Signed in." };
        } catch {
          set({ authLoading: false, isAuthenticated: false, authError: "Could not reach the server." });
          return { success: false, message: "Could not reach the server." };
        }
      },

      hasPermission: (permission: string) => {
        const { activeProperty, activeRole, userAssignments } = get();
        const permissions = userAssignments
          .filter((assignment) => assignment.property_id === activeProperty?.id)
          .flatMap((assignment) => assignment.role?.permissions ?? []);
        return permissions.length > 0
          ? permissionGranted(permissions, permission)
          : hasRolePermission(activeRole, permission);
      },

      logout: async () => {
        roomWorkspaceRequestSequence += 1;
        try {
          await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
        } catch {
          // Ignore network errors — clear local state regardless.
        }
        set({
          company: null,
          currentUser: null,
          isAuthenticated: false,
          authError: null,
          userAssignments: [],
          availableProperties: [],
          activeProperty: null,
          allOutlets: [],
          allStations: [],
          availableOutlets: [],
          activeOutlet: null,
          availableStations: [],
          activeStation: null,
          activeRole: null,
          activeAssignment: null,
          catalog: [],
          cart: [],
          menu: [],
          tableOrders: {},
          tableRounds: {},
          restaurantChecks: {},
          restaurantBills: [],
          kots: [],
          roomTypes: [],
          rooms: [],
          roomsLoading: false,
          roomWorkspacePropertyId: null,
          bookings: [],
          folios: [],
          activeShift: null,
          activeReservationShift: null,
        });
      },

      loadCatalog: async () => {
        const { activeOutlet, hasPermission } = get();
        const outletId = activeOutlet?.id;
        const canReadCatalog = hasPermission("pos:read") || hasPermission("catalog:read") || hasPermission("inventory:read");
        const includeSupplies = hasPermission("catalog:read");
        if (!canReadCatalog) {
          set({ catalog: [], catalogLoading: false });
          return;
        }
        if (!outletId) {
          set({ catalog: [] });
          return;
        }
        set({ catalogLoading: true });
        try {
          const query = new URLSearchParams({ outlet_id: outletId });
          if (includeSupplies) query.set("include_supplies", "true");
          const res = await fetch(`/api/pos/catalog?${query.toString()}`, { credentials: "include" });
          if (!res.ok) {
            set({ catalog: [], catalogLoading: false });
            return;
          }
          const data = await res.json();
          set({ catalog: data.items ?? [], catalogLoading: false });
        } catch {
          set({ catalog: [], catalogLoading: false });
        }
      },

      loadStockWorkspace: async () => {
        const { activeOutlet, hasPermission } = get();
        if (!activeOutlet) {
          set({ stockItems: [], stockLevels: {}, stockMovements: [], stockRequisitions: [] });
          return { success: false, message: "Select an outlet before loading stock records." };
        }
        if (!hasPermission("inventory:read")) {
          set({ stockItems: [], stockLevels: {}, stockMovements: [], stockRequisitions: [] });
          return { success: false, message: "You do not have permission to view stock records." };
        }
        try {
          const response = await fetch(`/api/stock?outlet_id=${encodeURIComponent(activeOutlet.id)}`, { credentials: "include" });
          const value: unknown = await response.json();
          if (!response.ok || typeof value !== "object" || value === null ||
              !("success" in value) || value.success !== true ||
              !("items" in value) || !Array.isArray(value.items) ||
              !("movements" in value) || !Array.isArray(value.movements) ||
              !("requisitions" in value) || !Array.isArray(value.requisitions)) {
            const message = typeof value === "object" && value !== null && "message" in value && typeof value.message === "string"
              ? value.message
              : "Stock and supply records could not be loaded.";
            set({ stockItems: [], stockLevels: {}, stockMovements: [], stockRequisitions: [] });
            return { success: false, message };
          }
          const data = value as StockWorkspacePayload;
          const stockItems = data.items ?? [];
          const stockLevels: Record<string, Record<string, number>> = {};
          for (const item of stockItems) {
            stockLevels[item.id] = {
              "central-store": item.central_quantity,
              [activeOutlet.id]: item.item_type === "supply"
                ? item.supplies_quantity
                : item.prep_station === "bar" ? item.bar_quantity : item.kitchen_quantity,
              [`${activeOutlet.id}:kitchen`]: item.kitchen_quantity,
              [`${activeOutlet.id}:bar`]: item.bar_quantity,
              [`${activeOutlet.id}:supplies`]: item.supplies_quantity,
            };
          }
          set({
            stockItems,
            stockLevels,
            stockMovements: data.movements ?? [],
            stockRequisitions: data.requisitions ?? [],
          });
          return { success: true, message: "Stock workspace loaded." };
        } catch {
          set({ stockItems: [], stockLevels: {}, stockMovements: [], stockRequisitions: [] });
          return { success: false, message: "Could not reach the server. Stock records could not be loaded." };
        }
      },

      loadRestaurantChecks: async () => {
        const { activeOutlet, activeProperty, hasPermission } = get();
        if (!activeOutlet) {
          set({ menu: [], tableOrders: {}, tableRounds: {}, restaurantChecks: {} });
          return { success: false, message: "Select an outlet before loading restaurant checks." };
        }
        if (!hasPermission("restaurant:read")) {
          set({ menu: [], tableOrders: {}, tableRounds: {}, restaurantChecks: {} });
          return { success: false, message: "You do not have permission to view restaurant checks." };
        }

        try {
          const response = await fetch(`/api/restaurant/checks?outlet_id=${encodeURIComponent(activeOutlet.id)}`, { credentials: "include" });
          const value: unknown = await response.json();
          if (!response.ok || typeof value !== "object" || value === null ||
              !("success" in value) || value.success !== true ||
              !("menu" in value) || !Array.isArray(value.menu) ||
              !("checks" in value) || !Array.isArray(value.checks)) {
            const message = typeof value === "object" && value !== null && "message" in value && typeof value.message === "string"
              ? value.message
              : "Restaurant checks could not be loaded.";
            set({ menu: [], tableOrders: {}, tableRounds: {}, restaurantChecks: {} });
            return { success: false, message };
          }

          const data = value as RestaurantChecksPayload;
          const callbackClearedTableIds = new Set<string>();
          let callbackSettlementError: string | null = null;
          for (const check of data.checks) {
            if (!check.callback_transaction_code) continue;
            const cleared = await postRestaurantCheck({
              action: "settle_callback",
              outlet_id: activeOutlet.id,
              table_id: check.table_id,
              table_name: check.table_name,
              callback_transaction_code: check.callback_transaction_code,
            });
            if (cleared.success || cleared.message === "Open restaurant bill not found.") {
              callbackClearedTableIds.add(check.table_id);
            } else if (!callbackSettlementError) {
              callbackSettlementError = `M-Pesa payment is confirmed, but the bill could not be cleared: ${cleared.message}`;
            }
          }
          const tableOrders: Record<string, TableOrderLine[]> = {};
          const tableRounds: Record<string, number> = {};
          const restaurantChecks: Record<string, RestaurantCheckInfo> = {};
          for (const check of data.checks) {
            if (callbackClearedTableIds.has(check.table_id)) continue;
            tableOrders[check.table_id] = check.lines;
            restaurantChecks[check.table_id] = {
              id: check.id,
              bill_number: check.bill_number,
              table_name: check.table_name,
              shift_id: check.shift_id,
              cashier_id: check.cashier_id,
              cashier_name: check.cashier_name,
              waiter_id: check.waiter_id,
              waiter_name: check.waiter_name,
              callback_transaction_code: check.callback_transaction_code,
            };
            const highestRound = check.lines.reduce((highest, line) => Math.max(highest, line.round), 1);
            tableRounds[check.table_id] = check.lines.some((line) => !line.sentToKitchen) ? highestRound : highestRound + 1;
          }
          const floorAreas = get().floorAreas.map((area) => ({
            ...area,
            property_id: activeProperty?.id ?? area.property_id,
            outlet_id: activeOutlet.id,
          }));
          const tables = get().tables.map((table) => ({
            ...table,
            property_id: activeProperty?.id ?? table.property_id,
            outlet_id: activeOutlet.id,
            status: table.status === "cleaning" ? "cleaning" as const : "available" as const,
          })).map((table) => tableOrders[table.id]?.length
            ? { ...table, status: "occupied" as const }
            : table);
          set({
            menu: data.menu,
            floorAreas,
            tables,
            tableOrders,
            tableRounds,
            restaurantChecks,
          });
          if (callbackSettlementError) return { success: false, message: callbackSettlementError };
          return { success: true, message: "Restaurant checks loaded." };
        } catch {
          set({ menu: [], tableOrders: {}, tableRounds: {}, restaurantChecks: {} });
          return { success: false, message: "Could not reach the server. Restaurant checks could not be loaded." };
        }
      },

      loadRestaurantKots: async () => {
        const { activeOutlet, hasPermission } = get();
        if (!activeOutlet) {
          set({ kots: [] });
          return { success: false, message: "Select an outlet before loading kitchen tickets." };
        }
        if (!hasPermission("kds:read") && !hasPermission("restaurant:read")) {
          set({ kots: [] });
          return { success: false, message: "You do not have permission to view kitchen tickets." };
        }
        set({ kots: [] });
        try {
          const response = await fetch(`/api/kds/tickets?outlet_id=${encodeURIComponent(activeOutlet.id)}`, { credentials: "include" });
          const value: unknown = await response.json();
          if (!response.ok || typeof value !== "object" || value === null ||
              !("success" in value) || value.success !== true ||
              !("tickets" in value) || !Array.isArray(value.tickets)) {
            const message = typeof value === "object" && value !== null && "message" in value && typeof value.message === "string"
              ? value.message
              : "Kitchen tickets could not be loaded.";
            set({ kots: [] });
            return { success: false, message };
          }
          const result = value as KotApiResult;
          set({ kots: result.tickets ?? [] });
          return { success: true, message: "Kitchen tickets loaded." };
        } catch {
          set({ kots: [] });
          return { success: false, message: "Could not reach the server. Kitchen tickets could not be loaded." };
        }
      },

      loadRestaurantBills: async (businessDate: string) => {
        const { activeOutlet, hasPermission } = get();
        if (!activeOutlet) {
          set({ restaurantBills: [] });
          return { success: false, message: "Select an outlet before loading restaurant bills." };
        }
        if (!hasPermission("restaurant:read")) {
          set({ restaurantBills: [] });
          return { success: false, message: "You do not have permission to view restaurant bills." };
        }
        try {
          const params = new URLSearchParams({ outlet_id: activeOutlet.id, business_date: businessDate });
          const response = await fetch(`/api/restaurant/bills?${params.toString()}`, { credentials: "include" });
          const value: unknown = await response.json();
          if (!response.ok || typeof value !== "object" || value === null ||
              !("success" in value) || value.success !== true ||
              !("bills" in value) || !Array.isArray(value.bills)) {
            const message = typeof value === "object" && value !== null && "message" in value && typeof value.message === "string"
              ? value.message
              : "Restaurant bills could not be loaded.";
            set({ restaurantBills: [] });
            return { success: false, message };
          }
          const result = value as RestaurantBillsPayload;
          set({ restaurantBills: result.bills ?? [] });
          return { success: true, message: "Restaurant bills loaded." };
        } catch {
          set({ restaurantBills: [] });
          return { success: false, message: "Could not reach the server. Restaurant bills could not be loaded." };
        }
      },

      saveDarajaConfig: (config) => {
        const propertyId = config.property_id || get().activeProperty?.id;
        if (!propertyId) return { success: false, message: "Select a property before saving Daraja settings." };

        const outletId = config.outlet_id || get().activeOutlet?.id;
        const existing = get().darajaConfigs.find((item) => item.property_id === propertyId && item.outlet_id === outletId);
        const nextRecord: DarajaShopConfig = {
          id: existing?.id || `daraja-${Date.now()}`,
          property_id: propertyId,
          outlet_id: outletId,
          enabled: config.enabled ?? true,
          environment: config.environment ?? "sandbox",
          short_code: config.short_code ?? existing?.short_code ?? "",
          consumer_key: config.consumer_key ?? existing?.consumer_key ?? "",
          consumer_secret: config.consumer_secret ?? existing?.consumer_secret ?? "",
          passkey: config.passkey ?? existing?.passkey ?? "",
          callback_url: config.callback_url ?? existing?.callback_url ?? "",
          timeout_url: config.timeout_url ?? existing?.timeout_url ?? "",
          created_at: existing?.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        set({
          darajaConfigs: existing
            ? get().darajaConfigs.map((item) => item.id === existing.id ? nextRecord : item)
            : [...get().darajaConfigs, nextRecord],
        });

        return { success: true, message: "Daraja credentials saved for this shop." };
      },

      registerMpesaPayment: (input) => {
        const transactionCode = input.transaction_code.trim().toUpperCase();
        if (!transactionCode) return { success: false, message: "Enter the M-Pesa transaction code to register the callback." };

        const payment: DarajaPaymentRecord = {
          id: `mpesa-${Date.now()}`,
          property_id: input.property_id,
          outlet_id: input.outlet_id,
          order_id: input.order_id,
          bill_reference: input.bill_reference,
          amount: input.amount,
          transaction_code: transactionCode,
          payer_phone: input.payer_phone,
          status: "pending",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        set({
          pendingMpesaPayments: [...get().pendingMpesaPayments.filter((item) => item.transaction_code !== transactionCode || item.order_id !== input.order_id), payment],
        });

        return { success: true, message: "M-Pesa payment registered. It is waiting for the callback to clear the bill.", payment };
      },

      confirmManualMpesaPayment: (input) => {
        const registered = get().registerMpesaPayment(input);
        if (!registered.success || !registered.payment) return registered;
        return get().processDarajaCallback({
          property_id: input.property_id,
          outlet_id: input.outlet_id,
          amount: input.amount,
          transaction_code: input.transaction_code,
          status: "paid",
          payer_phone: input.payer_phone,
          bill_reference: input.bill_reference,
          order_id: input.order_id,
          callback_payload: { source: "cashier_manual_confirmation" },
        });
      },

      processDarajaCallback: (input) => {
        const transactionCode = input.transaction_code.trim().toUpperCase();
        if (!transactionCode) return { success: false, message: "The callback payload is missing a transaction code." };

        const { pendingMpesaPayments } = get();
        const payment = pendingMpesaPayments.find((item) => {
          const sameTransaction = item.transaction_code === transactionCode;
          const sameOrder = !!input.order_id && item.order_id === input.order_id;
          const sameBill = !!input.bill_reference && item.bill_reference === input.bill_reference;
          return sameTransaction || sameOrder || sameBill;
        });

        if (!payment) {
          return { success: false, message: `No pending payment was found for transaction ${transactionCode}.` };
        }
        if (payment.property_id !== input.property_id) {
          return { success: false, message: "This payment belongs to a different property." };
        }
        if (input.amount > 0 && Math.abs(input.amount - payment.amount) > 0.009) {
          return { success: false, message: `Callback amount does not match the pending bill of KSh ${payment.amount.toFixed(2)}.` };
        }
        if (payment.status === "paid") {
          return { success: true, message: `Transaction ${transactionCode} was already applied.`, payment };
        }

        const nextStatus = input.status === "paid" ? "paid" : input.status === "failed" ? "failed" : "timeout";
        const nextPayment: DarajaPaymentRecord = {
          ...payment,
          amount: input.amount || payment.amount,
          payer_phone: input.payer_phone || payment.payer_phone,
          status: nextStatus,
          bill_reference: input.bill_reference || payment.bill_reference,
          order_id: input.order_id || payment.order_id,
          callback_payload: input.callback_payload || payment.callback_payload,
          updated_at: new Date().toISOString(),
        };

        set({
          pendingMpesaPayments: pendingMpesaPayments.map((item) => item.id === payment.id ? nextPayment : item),
        });

        return {
          success: nextStatus === "paid",
          message: nextStatus === "paid"
            ? `M-Pesa callback cleared KSh ${nextPayment.amount.toFixed(2)} for ${transactionCode}.`
            : `M-Pesa callback for ${transactionCode} was marked as ${nextStatus}.`,
          payment: nextPayment,
        };
      },

      switchProperty: (propertyId: string) => {
        const { availableProperties, userAssignments, allOutlets, allStations } = get();
        const prop = availableProperties.find(p => p.id === propertyId);
        if (!prop) return;

        const outlets = allOutlets.filter(o => o.property_id === prop.id && o.is_active);
        const activeOutlet = outlets[0] || null;
        const stations = activeOutlet ? allStations.filter(s => s.outlet_id === activeOutlet.id && s.is_active) : [];
        const activeStation = stations[0] || null;

        const assignment = userAssignments.find(a => a.property_id === prop.id) || null;
        const role = assignment?.role || null;

        roomWorkspaceRequestSequence += 1;
        set({
          activeProperty: prop,
          availableOutlets: outlets,
          activeOutlet: activeOutlet,
          availableStations: stations,
          activeStation: activeStation,
          activeAssignment: assignment,
          activeRole: role,
          activeShift: null,
          activeReservationShift: null,
          roomTypes: [],
          rooms: [],
          roomsLoading: false,
          roomWorkspacePropertyId: null,
          bookings: [],
          folios: [],
        });
        void get().loadCatalog();
      },

      switchOutlet: (outletId: string) => {
        const { availableOutlets, allStations } = get();
        const outlet = availableOutlets.find(o => o.id === outletId);
        if (!outlet) return;

        const stations = allStations.filter(s => s.outlet_id === outlet.id && s.is_active);
        set({
          activeOutlet: outlet,
          availableStations: stations,
          activeStation: stations[0] || null,
          activeShift: null,
          activeReservationShift: null,
        });
        void get().loadCatalog();
      },

      switchStation: (stationId: string) => {
        const { availableStations } = get();
        const stn = availableStations.find(s => s.id === stationId);
        if (!stn) return;
        set({ activeStation: stn, activeShift: null, activeReservationShift: null });
      },

      addToCart: (item: CatalogItem) => {
        const { cart } = get();
        const existing = cart.find((line) => line.item.id === item.id);
        if (existing) {
          set({ cart: cart.map((line) => line.item.id === item.id ? { ...line, quantity: line.quantity + 1 } : line) });
          return;
        }
        set({ cart: [...cart, { item, quantity: 1 }] });
      },

      updateCartQuantity: (itemId: string, quantity: number) => {
        const nextCart = get().cart
          .map((line) => line.item.id === itemId ? { ...line, quantity: Math.max(0, quantity) } : line)
          .filter((line) => line.quantity > 0);
        set({ cart: nextCart });
      },

      clearCart: () => set({ cart: [] }),
      clearReceipt: () => set({ lastReceipt: null }),

      addCatalogItem: async (input) => {
        const { activeOutlet } = get();
        if (!activeOutlet) return { success: false, message: "Select an outlet before adding catalog items." };
        try {
          const res = await fetch("/api/pos/catalog", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              outlet_id: activeOutlet.id,
              name: input.name,
              item_type: input.item_type,
              unit: input.unit,
              category: input.category,
              price: input.price,
              initial_stock_kitchen: input.initial_stock_kitchen,
              initial_stock_bar: input.initial_stock_bar,
              reorder_level: input.reorder_level,
              stock_tracked: input.stock_tracked,
              prep_station: input.prep_station,
              digitax_template_id: input.digitax_template_id,
            }),
          });
          const data = await res.json();
          if (!res.ok || !data.success) return { success: false, message: data.message || "Could not create the item." };
          await get().loadCatalog();
          return { success: true, message: data.message || "Item added to catalog." };
        } catch {
          return { success: false, message: "Could not reach the server." };
        }
      },

      addItemToTable: (tableId: string, item: CatalogItem) => serializeRestaurantMutation(tableId, async () => {
        const { activeOutlet, currentUser, hasPermission, restaurantChecks, tableOrders, tableRounds, tables } = get();
        if (!hasPermission("restaurant:write")) return { success: false, message: "You do not have permission to update restaurant checks." };
        if (!activeOutlet || !currentUser) return { success: false, message: "An active user and outlet are required." };
        const existingCheck = restaurantChecks[tableId];
        if (existingCheck && existingCheck.waiter_id !== currentUser.id) {
          return { success: false, message: `This bill belongs to waiter ${existingCheck.waiter_name}.` };
        }
        const currentRound = tableRounds[tableId] || 1;
        const existingLines = tableOrders[tableId] || [];
        const existing = existingLines.find((line) => line.item.id === item.id && line.round === currentRound && !line.sentToKitchen);
        const nextLines = existing
          ? existingLines.map((line) => line === existing ? { ...line, quantity: line.quantity + 1 } : line)
          : [...existingLines, { item, quantity: 1, round: currentRound, sentToKitchen: false }];
        const table = tables.find((candidate) => candidate.id === tableId);
        const result = await postRestaurantCheck({
          action: "save",
          outlet_id: activeOutlet.id,
          table_id: tableId,
          table_name: table?.name || existingCheck?.table_name || tableId,
          lines: nextLines.map((line) => ({
            item_id: line.item.id,
            quantity: line.quantity,
            round: line.round,
            sent_to_kitchen: line.sentToKitchen,
            instructions: line.instructions,
          })),
        });
        if (!result.success || !result.check_id || !result.cashier_id || !result.cashier_name || !result.shift_id) return result;

        const check: RestaurantCheckInfo = {
          id: result.check_id,
          bill_number: result.bill_number || existingCheck?.bill_number || "",
          table_name: table?.name || existingCheck?.table_name || tableId,
          shift_id: result.shift_id,
          cashier_id: result.cashier_id,
          cashier_name: result.cashier_name,
          waiter_id: result.waiter_id || currentUser.id,
          waiter_name: result.waiter_name || currentUser.full_name,
        };
        set({
          tableOrders: { ...get().tableOrders, [tableId]: nextLines },
          tableRounds: { ...get().tableRounds, [tableId]: currentRound },
          restaurantChecks: { ...get().restaurantChecks, [tableId]: check },
          tables: get().tables.map((candidate) => candidate.id === tableId ? { ...candidate, status: "occupied" } : candidate),
        });
        return { success: true, message: result.message };
      }),

      updateTableItemQuantity: (tableId: string, itemId: string, quantity: number, round: number) => serializeRestaurantMutation(tableId, async () => {
        const { activeOutlet, currentUser, hasPermission, restaurantChecks, tableOrders, tables } = get();
        if (!hasPermission("restaurant:write")) return { success: false, message: "You do not have permission to update restaurant checks." };
        if (!activeOutlet || !currentUser) return { success: false, message: "An active user and outlet are required." };
        const existingCheck = restaurantChecks[tableId];
        if (!existingCheck) return { success: false, message: "Restaurant bill is not loaded. Reload the dining page and try again." };
        if (existingCheck.waiter_id !== currentUser.id) return { success: false, message: `This bill belongs to waiter ${existingCheck.waiter_name}.` };
        const existingLines = tableOrders[tableId] || [];
        const target = existingLines.find((line) => line.item.id === itemId && line.round === round);
        if (!target) return { success: false, message: "The selected bill line was not found." };
        if (target.sentToKitchen) return { success: false, message: "Items already sent to the kitchen cannot be changed." };
        const nextQuantity = Math.max(0, quantity);
        const nextLines = existingLines
          .map((line) => line.item.id === itemId && line.round === round ? { ...line, quantity: nextQuantity } : line)
          .filter((line) => line.quantity > 0);
        const table = tables.find((candidate) => candidate.id === tableId);
        const result = nextLines.length
          ? await postRestaurantCheck({
            action: "save",
            outlet_id: activeOutlet.id,
            table_id: tableId,
            table_name: table?.name || existingCheck.table_name,
            lines: nextLines.map((line) => ({
              item_id: line.item.id,
              quantity: line.quantity,
              round: line.round,
              sent_to_kitchen: line.sentToKitchen,
              instructions: line.instructions,
            })),
          })
          : await postRestaurantCheck({ action: "void", outlet_id: activeOutlet.id, table_id: tableId, table_name: table?.name || existingCheck.table_name });
        if (!result.success) return result;

        if (nextLines.length && result.check_id && result.cashier_id && result.cashier_name && result.shift_id) {
          const check: RestaurantCheckInfo = {
            id: result.check_id,
            bill_number: result.bill_number || existingCheck.bill_number,
            table_name: table?.name || existingCheck.table_name,
            shift_id: result.shift_id,
            cashier_id: result.cashier_id,
            cashier_name: result.cashier_name,
            waiter_id: result.waiter_id || currentUser.id,
            waiter_name: result.waiter_name || currentUser.full_name,
          };
          set({ tableOrders: { ...get().tableOrders, [tableId]: nextLines }, restaurantChecks: { ...get().restaurantChecks, [tableId]: check } });
        } else if (!nextLines.length) {
          const { [tableId]: _removedOrder, ...remainingOrders } = get().tableOrders;
          const { [tableId]: _removedRound, ...remainingRounds } = get().tableRounds;
          const { [tableId]: _removedCheck, ...remainingChecks } = get().restaurantChecks;
          set({
            tableOrders: remainingOrders,
            tableRounds: remainingRounds,
            restaurantChecks: remainingChecks,
            restaurantBills: get().restaurantBills.map((bill) =>
              bill.id === existingCheck.id ? { ...bill, status: "voided" } : bill
            ),
            tables: get().tables.map((candidate) => candidate.id === tableId ? { ...candidate, status: "available" } : candidate),
          });
        }
        return result;
      }),

      updateTableLineInstructions: (tableId: string, itemId: string, round: number, instructions: string) => serializeRestaurantMutation(tableId, async () => {
        const { activeOutlet, currentUser, hasPermission, restaurantChecks, tableOrders, tables } = get();
        if (!hasPermission("restaurant:write")) return { success: false, message: "You do not have permission to update restaurant checks." };
        if (!activeOutlet || !currentUser) return { success: false, message: "An active user and outlet are required." };
        const normalizedInstructions = instructions.trim();
        if (normalizedInstructions.length > 500) return { success: false, message: "Preparation notes must be 500 characters or fewer." };
        const existingCheck = restaurantChecks[tableId];
        if (!existingCheck) return { success: false, message: "Restaurant bill is not loaded. Reload the dining page and try again." };
        if (existingCheck.waiter_id !== currentUser.id) return { success: false, message: `This bill belongs to waiter ${existingCheck.waiter_name}.` };
        const existingLines = tableOrders[tableId] || [];
        const target = existingLines.find((line) => line.item.id === itemId && line.round === round);
        if (!target) return { success: false, message: "The selected bill line was not found." };
        if (target.sentToKitchen) return { success: false, message: "Preparation notes cannot be changed after sending the item to the kitchen." };
        if ((target.instructions ?? "") === normalizedInstructions) return { success: true, message: "Preparation notes are unchanged." };
        const nextLines = existingLines.map((line) =>
          line.item.id === itemId && line.round === round
            ? { ...line, instructions: normalizedInstructions || undefined }
            : line
        );
        const table = tables.find((candidate) => candidate.id === tableId);
        const result = await postRestaurantCheck({
          action: "save",
          outlet_id: activeOutlet.id,
          table_id: tableId,
          table_name: table?.name || existingCheck.table_name,
          lines: nextLines.map((line) => ({
            item_id: line.item.id,
            quantity: line.quantity,
            round: line.round,
            sent_to_kitchen: line.sentToKitchen,
            instructions: line.instructions,
          })),
        });
        if (!result.success) return result;
        set({ tableOrders: { ...get().tableOrders, [tableId]: nextLines } });
        return { success: true, message: "Preparation notes saved." };
      }),

      sendRoundToKitchen: (tableId: string) => serializeRestaurantMutation(tableId, async () => {
        const { activeOutlet, currentUser, hasPermission, restaurantChecks, tableOrders, tableRounds, tables } = get();
        if (!hasPermission("restaurant:write")) return { success: false, message: "You do not have permission to update restaurant checks." };
        if (!activeOutlet || !currentUser) return { success: false, message: "An active user and outlet are required." };
        const existingCheck = restaurantChecks[tableId];
        if (!existingCheck) return { success: false, message: "Restaurant bill is not loaded. Add an item before sending a round." };
        if (existingCheck.waiter_id !== currentUser.id) return { success: false, message: `This bill belongs to waiter ${existingCheck.waiter_name}.` };
        const lines = tableOrders[tableId] || [];
        const unsent = lines.filter((line) => !line.sentToKitchen);
        if (unsent.length === 0) return { success: false, message: "There are no unsent items." };

        const table = tables.find((candidate) => candidate.id === tableId);
        const result = await postRestaurantCheck({
          action: "save",
          outlet_id: activeOutlet.id,
          table_id: tableId,
          table_name: table?.name || existingCheck.table_name,
          lines: lines.map((line) => ({
            item_id: line.item.id,
            quantity: line.quantity,
            round: line.round,
            sent_to_kitchen: true,
            instructions: line.instructions,
          })),
          create_kots: true,
        });
        if (!result.success) return result;
        const kitchenItemCount = unsent.filter((line) => line.item.prep_station !== "bar").length;
        if (kitchenItemCount > 0 && !result.kots?.length) {
          return { success: false, message: "The kitchen order was not added to the ticket queue. Reload the dining page before retrying." };
        }

        const currentRound = tableRounds[tableId] || 1;
        const nextLines = lines.map((line) => line.sentToKitchen ? line : { ...line, sentToKitchen: true });
        const ticketsById = new Map(get().kots.map((ticket) => [ticket.id, ticket]));
        for (const ticket of result.kots ?? []) ticketsById.set(ticket.id, ticket);
        set({
          tableOrders: { ...get().tableOrders, [tableId]: nextLines },
          tableRounds: { ...get().tableRounds, [tableId]: currentRound + 1 },
          kots: Array.from(ticketsById.values()),
        });
        const barItemCount = unsent.length - kitchenItemCount;
        const message = kitchenItemCount > 0 && barItemCount > 0
          ? "Kitchen items were ticketed; bar items were routed to the bar without a KOT."
          : barItemCount > 0
            ? "Order round routed to the bar without creating a KOT."
            : "Order round sent to the kitchen.";
        return { success: true, message };
      }),

      transitionKot: async (kotId: string, nextStatus: KotStatus, reason?: string) => {
        const { activeOutlet, hasPermission, kots } = get();
        if (!hasPermission("kds:manage")) return { success: false, message: "You do not have permission to manage kitchen tickets." };
        if (!activeOutlet) return { success: false, message: "Select an outlet before updating kitchen tickets." };
        const kot = kots.find((k) => k.id === kotId);
        if (!kot) return { success: false, message: "Ticket not found." };
        const legalNextStates = KOT_LEGAL_TRANSITIONS[kot.status];
        if (!legalNextStates.includes(nextStatus)) {
          return { success: false, message: `Cannot move ticket from ${kot.status} to ${nextStatus}.` };
        }
        if (nextStatus === "cancelled" && !reason?.trim()) {
          return { success: false, message: "A cancellation reason is required." };
        }
        try {
          const response = await fetch("/api/kds/tickets", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              outlet_id: activeOutlet.id,
              ticket_id: kotId,
              next_status: nextStatus,
              reason,
            }),
          });
          const value: unknown = await response.json();
          if (!response.ok || typeof value !== "object" || value === null ||
              !("success" in value) || value.success !== true ||
              !("ticket" in value) || typeof value.ticket !== "object" || value.ticket === null) {
            const message = typeof value === "object" && value !== null && "message" in value && typeof value.message === "string"
              ? value.message
              : "Kitchen ticket status could not be updated.";
            return { success: false, message };
          }
          const result = value as KotApiResult;
          if (!result.ticket) return { success: false, message: "The server returned no updated kitchen ticket." };
          set({ kots: get().kots.map((ticket) => ticket.id === kotId ? result.ticket! : ticket) });
          return { success: true, message: result.message || `Ticket moved to ${nextStatus}.` };
        } catch {
          return { success: false, message: "Could not reach the server. Kitchen ticket status was not changed." };
        }
      },

      requestBill: (tableId: string) => {
        const { tables } = get();
        set({ tables: tables.map((table) => table.id === tableId ? { ...table, status: "bill_requested" } : table) });
      },

      settleTable: (tableId: string, tenders: TenderLine[], idempotencyKey: string) => serializeRestaurantMutation(tableId, async () => {
        const { activeOutlet, currentUser, hasPermission, restaurantChecks, tableOrders, lastCheckoutKey, tables } = get();
        if (!hasPermission("restaurant:settle")) return { success: false, message: "Only an authorized cashier can clear waiter bills." };
        if (!activeOutlet || !currentUser) return { success: false, message: "An active user and outlet are required." };
        if (lastCheckoutKey === idempotencyKey) return { success: false, message: "This bill was already settled." };
        const check = restaurantChecks[tableId];
        if (!check) return { success: false, message: "Restaurant bill is not loaded. Reload the dining page and try again." };
        if (check.waiter_id !== currentUser.id && !hasPermission("restaurant:settle")) {
          return { success: false, message: `Only the assigned waiter or an authorized cashier can settle this bill.` };
        }
        const lines = tableOrders[tableId] || [];
        if (lines.length === 0) return { success: false, message: "This table has no order to settle." };

        const total = lines.reduce((sum, line) => sum + line.item.price * line.quantity, 0);
        const tendered = tenders.reduce((sum, tender) => sum + tender.amount, 0);
        if (Math.abs(tendered - total) > 0.009) return { success: false, message: `Tender total must equal ${total.toFixed(2)}.` };
        if (tenders.length === 0) return { success: false, message: "Enter at least one tender amount." };
        if (tenders.some((tender) => tender.type === "mpesa" && !tender.reference?.trim())) return { success: false, message: "Enter the M-Pesa transaction reference." };

        const response = await postRestaurantCheck({
          action: "settle",
          outlet_id: activeOutlet.id,
          table_id: tableId,
          table_name: tables.find((table) => table.id === tableId)?.name || restaurantChecks[tableId]?.table_name || tableId,
          idempotency_key: idempotencyKey,
          tenders,
        });
        if (!response.success) return response;
        const settledTotal = typeof response.total === "number" ? response.total : total;
        const orderId = response.check_id || `dine-order-${Date.now()}`;
        const { [tableId]: _removedOrder, ...remainingOrders } = get().tableOrders;
        const { [tableId]: _removedRound, ...remainingRounds } = get().tableRounds;
        const { [tableId]: _removedCheck, ...remainingChecks } = get().restaurantChecks;
        const journalEntries = get().journalEntries;
        const saleEntry = buildJournalEntry(
          `JE-${journalEntries.length + 1}`,
          `Dine-in bill settled ${orderId}`,
          "pos_sale",
          orderId,
          [
            ...tenders.map((tender) => ({ account_id: tenderAccount(tender.type), debit: tender.amount, credit: 0 })),
            { account_id: ACCT_SALES_REVENUE, debit: 0, credit: settledTotal },
          ],
        );
        set({
          tables: get().tables.map((table) => table.id === tableId ? { ...table, status: "cleaning" } : table),
          tableOrders: remainingOrders,
          tableRounds: remainingRounds,
          restaurantChecks: remainingChecks,
          kots: get().kots.filter((ticket) =>
            ticket.check_id !== check.id || (ticket.status !== "served" && ticket.status !== "cancelled")
          ),
          restaurantBills: get().restaurantBills.map((bill) =>
            bill.id === check.id ? { ...bill, status: "settled", settled_at: new Date().toISOString() } : bill
          ),
          lastCheckoutKey: idempotencyKey,
          journalEntries: saleEntry ? [...journalEntries, saleEntry] : journalEntries,
          lastReceipt: {
            receipt_number: `KB-DINE-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${orderId.slice(-6)}`,
            order_id: orderId,
            issued_at: new Date().toISOString(),
            cashier_name: response.cashier_name || check.cashier_name,
            lines: lines.map((line) => ({ item: line.item, quantity: line.quantity })),
            tenders,
            total: settledTotal,
          },
        });
        return { success: true, message: response.message };
      }),

      markTableAvailable: (tableId: string) => {
        const { tables } = get();
        set({ tables: tables.map((table) => table.id === tableId ? { ...table, status: "available" } : table) });
      },

      transferTableOrder: (fromTableId: string, toTableId: string) => {
        const { tableOrders, tableRounds, tables, restaurantChecks } = get();
        if (fromTableId === toTableId) return { success: false, message: "Choose a different destination table." };
        if (restaurantChecks[fromTableId]) return { success: false, message: "A persisted restaurant bill cannot be transferred yet. Settle it at its current table first." };
        const targetLines = tableOrders[toTableId] || [];
        if (targetLines.length > 0) return { success: false, message: "Destination table already has an active order." };

        const movingLines = tableOrders[fromTableId] || [];
        if (movingLines.length === 0) return { success: false, message: "There is no order to transfer." };

        const { [fromTableId]: _movedOrder, ...remainingOrders } = tableOrders;
        const { [fromTableId]: movedRound, ...remainingRounds } = tableRounds;

        set({
          tableOrders: { ...remainingOrders, [toTableId]: movingLines },
          tableRounds: { ...remainingRounds, [toTableId]: movedRound || 1 },
          tables: tables.map((table) => {
            if (table.id === fromTableId) return { ...table, status: "available" };
            if (table.id === toTableId) return { ...table, status: "occupied" };
            return table;
          }),
        });
        return { success: true, message: `Order transferred to ${tables.find((table) => table.id === toTableId)?.name}.` };
      },

      loadRoomWorkspace: async (propertyId) => {
        const current = get();
        const { hasPermission } = current;
        const requestId = ++roomWorkspaceRequestSequence;
        if (!propertyId || (!hasPermission("frontdesk:read") && !hasPermission("housekeeping:write"))) {
          set({ roomTypes: [], rooms: [], bookings: [], folios: [], roomChargeRequests: [], roomsLoading: false, roomWorkspacePropertyId: null });
          return { success: false, message: "You do not have permission to view rooms in this property." };
        }
        const sameWorkspace = current.roomWorkspacePropertyId === propertyId;
        set({
          roomTypes: sameWorkspace ? current.roomTypes : [],
          rooms: sameWorkspace ? current.rooms : [],
          bookings: sameWorkspace ? current.bookings : [],
          folios: sameWorkspace ? current.folios : [],
          roomChargeRequests: sameWorkspace ? current.roomChargeRequests : [],
          roomsLoading: !sameWorkspace,
          roomWorkspacePropertyId: propertyId,
        });
        try {
          const response = await fetch(`/api/rooms?property_id=${encodeURIComponent(propertyId)}`, { credentials: "include" });
          const value: unknown = await response.json();
          const validWorkspace = typeof value === "object" && value !== null &&
            "success" in value && value.success === true &&
            "roomTypes" in value && Array.isArray(value.roomTypes) &&
            "rooms" in value && Array.isArray(value.rooms) &&
            "bookings" in value && Array.isArray(value.bookings) &&
            "folios" in value && Array.isArray(value.folios);
          if (requestId !== roomWorkspaceRequestSequence) return { success: true, message: "Room workspace changed." };
          if (!response.ok || !validWorkspace) {
            const message = typeof value === "object" && value !== null && "message" in value && typeof value.message === "string"
              ? value.message
              : "Room, booking, and folio records could not be loaded.";
            set({ roomsLoading: false });
            return { success: false, message };
          }
          const data = value as RoomWorkspacePayload;
          set({
            roomTypes: data.roomTypes ?? [],
            rooms: data.rooms ?? [],
            bookings: data.bookings ?? [],
            folios: data.folios ?? [],
            roomChargeRequests: data.roomChargeRequests ?? [],
            roomsLoading: false,
          });
          return { success: true, message: "Room workspace loaded." };
        } catch {
          if (requestId !== roomWorkspaceRequestSequence) return { success: true, message: "Room workspace changed." };
          set({ roomsLoading: false });
          return { success: false, message: "Could not reach the server. Room records were not loaded." };
        }
      },

      createRoomType: async (input) => {
        const { activeProperty } = get();
        if (!activeProperty) return { success: false, message: "Select a property before creating room types." };
        return completeRoomAction(get, activeProperty.id, "create_room_type", {
          name: input.name,
          rate_per_night: input.ratePerNight,
        });
      },

      createRoom: async (input) => {
        const { activeProperty } = get();
        if (!activeProperty) return { success: false, message: "Select a property before creating rooms." };
        return completeRoomAction(get, activeProperty.id, "create_room", {
          room_type_id: input.roomTypeId,
          number: input.number,
          floor: input.floor,
        });
      },

      checkInBooking: async (bookingId) => {
        const { activeProperty } = get();
        if (!activeProperty) return { success: false, message: "No active property selected." };
        return completeRoomAction(get, activeProperty.id, "check_in", { booking_id: bookingId });
      },

      checkOutBooking: async (bookingId) => {
        const { activeProperty } = get();
        if (!activeProperty) return { success: false, message: "No active property selected." };
        return completeRoomAction(get, activeProperty.id, "check_out", { booking_id: bookingId });
      },

      postFolioCharge: async (folioId, description, amount) => {
        const { activeProperty } = get();
        if (!activeProperty) return { success: false, message: "No active property selected." };
        return completeRoomAction(get, activeProperty.id, "folio_charge", {
          folio_id: folioId,
          description,
          amount,
        });
      },

      recordFolioPayment: async (folioId, tenders) => {
        const { activeProperty } = get();
        if (!activeProperty) return { success: false, message: "No active property selected." };
        return completeRoomAction(get, activeProperty.id, "folio_payment", { folio_id: folioId, tenders });
      },

      createBooking: async (input) => {
        const { activeProperty } = get();
        if (!activeProperty) return { success: false, message: "No active property selected." };
        return completeRoomAction(get, activeProperty.id, "create_booking", {
          room_id: input.roomId,
          guest_name: input.guestName,
          guest_phone: input.guestPhone,
          check_in_date: input.checkInDate,
          check_out_date: input.checkOutDate,
          guest_count: input.guestCount,
          meal_add_ons: input.mealAddOns,
        });
      },

      requestRoomCharge: async (tableId, bookingId) => {
        const { activeProperty, activeOutlet, restaurantChecks } = get();
        const check = restaurantChecks[tableId];
        if (!activeProperty || !activeOutlet) return { success: false, message: "Select a property and restaurant outlet first." };
        if (!check) return { success: false, message: "Open a saved restaurant bill before requesting a room charge." };
        return postRestaurantRoomCharge({
          action: "request",
          property_id: activeProperty.id,
          outlet_id: activeOutlet.id,
          check_id: check.id,
          booking_id: bookingId,
        });
      },

      acceptRoomChargeRequest: async (requestId) => {
        const { activeProperty } = get();
        if (!activeProperty) return { success: false, message: "No active property selected." };
        const result = await postRestaurantRoomCharge({
          action: "approve",
          property_id: activeProperty.id,
          request_id: requestId,
        });
        if (!result.success) return result;
        const refreshed = await get().loadRoomWorkspace(activeProperty.id);
        return refreshed.success ? result : { success: true, message: `${result.message} The room workspace could not refresh: ${refreshed.message}` };
      },

      rejectRoomChargeRequest: async (requestId, reason) => {
        const { activeProperty } = get();
        if (!activeProperty) return { success: false, message: "No active property selected." };
        const result = await postRestaurantRoomCharge({
          action: "reject",
          property_id: activeProperty.id,
          request_id: requestId,
          reason,
        });
        if (!result.success) return result;
        const refreshed = await get().loadRoomWorkspace(activeProperty.id);
        return refreshed.success ? result : { success: true, message: `${result.message} The room workspace could not refresh: ${refreshed.message}` };
      },

      updateApprovalPolicy: (policyId: string, threshold: number) => {
        const { approvalPolicies } = get();
        set({ approvalPolicies: approvalPolicies.map((p) => p.id === policyId ? { ...p, threshold } : p) });
      },

      loadShift: async (area: ShiftArea) => {
        const stationId = get().activeStation?.id;
        if (!stationId) {
          if (area === "pos") set({ activeShift: null });
          else set({ activeReservationShift: null });
          return { success: false, message: "Select an outlet and station before loading a shift." };
        }
        try {
          const params = new URLSearchParams({ station_id: stationId, area });
          const response = await fetch(`/api/pos/shifts?${params.toString()}`, { credentials: "include" });
          const data = await response.json();
          if (!response.ok || !data.success) return { success: false, message: data.message || "Could not load the shift." };
          if (area === "pos") set({ activeShift: data.shift });
          else set({ activeReservationShift: data.shift });
          return { success: true, message: "Shift loaded." };
        } catch {
          return { success: false, message: "Could not reach the server." };
        }
      },

      openShift: async (area: ShiftArea, period: ShiftPeriod, businessDate: string, openingFloat: number) => {
        const { activeOutlet, activeStation } = get();
        if (!activeOutlet || !activeStation) return { success: false, message: "Select an outlet and station before opening a shift." };
        try {
          const res = await fetch("/api/pos/shifts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              outlet_id: activeOutlet.id,
              station_id: activeStation.id,
              area,
              period,
              business_date: businessDate,
              opening_float: Math.max(0, openingFloat),
            }),
          });
          const data = await res.json();
          if (!res.ok || !data.success) return { success: false, message: data.message || "Could not open shift." };
          if (area === "pos") set({ activeShift: data.shift });
          else set({ activeReservationShift: data.shift });
          return { success: true, message: data.message || "Shift opened." };
        } catch {
          return { success: false, message: "Could not reach the server." };
        }
      },

      closeShift: async (area: ShiftArea, countedCash: number) => {
        const { activeShift, activeReservationShift, roomChargeRequests } = get();
        const shift = area === "pos" ? activeShift : activeReservationShift;
        if (!shift || shift.status !== "open") return { success: false, message: "No open shift to close." };

        const unresolved = area === "pos"
          ? roomChargeRequests.filter((r) => r.status === "pending" && r.requested_by_user_id === shift.cashier_id)
          : [];
        if (unresolved.length > 0) {
          return { success: false, message: `Cannot close shift: ${unresolved.length} room-charge request(s) still pending reception approval.` };
        }

        try {
          const res = await fetch(`/api/pos/shifts/${shift.id}/close`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ counted_cash: countedCash }),
          });
          const data = await res.json();
          if (!res.ok || !data.success) return { success: false, message: data.message || "Could not close shift." };
          if (area === "pos") set({ activeShift: null });
          else set({ activeReservationShift: null });
          return { success: true, message: data.message };
        } catch {
          return { success: false, message: "Could not reach the server." };
        }
      },

      checkout: async (tenders: TenderLine[], idempotencyKey: string) => {
        const { activeShift, activeOutlet, activeStation, cart, lastCheckoutKey } = get();
        if (lastCheckoutKey === idempotencyKey) return { success: false, message: "This checkout was already submitted." };
        if (!activeShift || activeShift.status !== "open") return { success: false, message: "Open a cashier shift before checkout." };
        if (!activeOutlet || !activeStation) return { success: false, message: "Select an outlet and station before checkout." };
        if (cart.length === 0) return { success: false, message: "Add at least one item before checkout." };
        const total = cart.reduce((sum, line) => sum + line.item.price * line.quantity, 0);
        const tendered = tenders.reduce((sum, tender) => sum + tender.amount, 0);
        if (Math.abs(tendered - total) > 0.009) return { success: false, message: `Tender total must equal ${total.toFixed(2)}.` };
        if (tenders.some((tender) => tender.type === "mpesa" && !tender.reference?.trim())) return { success: false, message: "Enter the M-Pesa transaction reference." };

        const offline = typeof navigator !== "undefined" && !navigator.onLine;
        if (offline) {
          void enqueueOfflineOperation({
            operation_key: `pos_checkout:${idempotencyKey}`,
            type: "pos_checkout",
            payload: {
              idempotencyKey,
              items: cart.map((line) => ({ itemId: line.item.id, quantity: line.quantity, price: line.item.price })),
              tenders,
              total,
              created_at: new Date().toISOString(),
            },
          });
          set({
            cart: [],
            lastCheckoutKey: idempotencyKey,
            lastReceipt: {
              receipt_number: `OFFLINE-${idempotencyKey.slice(-8)}`,
              order_id: idempotencyKey,
              issued_at: new Date().toISOString(),
              cashier_name: get().currentUser?.full_name || "Unknown cashier",
              lines: cart,
              tenders,
              total,
            },
            activeShift: { ...activeShift, cash_sales: activeShift.cash_sales + tenders.filter((t) => t.type === "cash").reduce((sum, t) => sum + t.amount, 0) },
          });
          return { success: true, message: `Sale queued and recorded locally for ${total.toFixed(2)}.` };
        }

        try {
          const res = await fetch("/api/pos/orders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              outlet_id: activeOutlet.id,
              station_id: activeStation.id,
              shift_id: activeShift.id,
              idempotency_key: idempotencyKey,
              lines: cart.map((line) => ({ item_id: line.item.id, quantity: line.quantity })),
              tenders,
            }),
          });
          const data = await res.json();
          if (!res.ok || !data.success) return { success: false, message: data.message || "Checkout failed." };

          const cashAmount = tenders.filter((tender) => tender.type === "cash").reduce((sum, tender) => sum + tender.amount, 0);
          set({
            cart: [],
            lastCheckoutKey: idempotencyKey,
            lastReceipt: { ...data.receipt, lines: cart },
            activeShift: { ...activeShift, cash_sales: activeShift.cash_sales + cashAmount },
          });
          void get().loadCatalog();
          return { success: true, message: data.message || `Sale completed for ${total.toFixed(2)}.` };
        } catch {
          return { success: false, message: "Could not reach the server." };
        }
      },

      recordExpense: (description: string, amount: number, accountId: string, category: string) => {
        const { expenses, journalEntries } = get();
        if (amount <= 0) return { success: false, message: "Enter an amount greater than zero." };
        if (!description.trim()) return { success: false, message: "Enter a description." };
        const expenseId = `exp-${Date.now()}`;
        const entry = buildJournalEntry(
          `JE-${journalEntries.length + 1}`,
          `Expense: ${description}`,
          "expense",
          expenseId,
          [
            { account_id: accountId, debit: amount, credit: 0 },
            { account_id: ACCT_CASH, debit: 0, credit: amount },
          ],
        );
        if (!entry) return { success: false, message: "Entry does not balance." };
        set({
          expenses: [...expenses, { id: expenseId, description, amount, account_id: accountId, category, created_at: new Date().toISOString() }],
          journalEntries: [...journalEntries, entry],
        });
        return { success: true, message: `Expense of ${amount.toFixed(2)} recorded and posted.` };
      },

      postManualJournalEntry: (description: string, lines: JournalLine[]) => {
        const { journalEntries } = get();
        if (!description.trim()) return { success: false, message: "Enter a description." };
        if (lines.length < 2) return { success: false, message: "A journal entry needs at least two lines." };
        const entry = buildJournalEntry(`JE-${journalEntries.length + 1}`, description, "manual", undefined, lines);
        if (!entry) return { success: false, message: "Debits must equal credits before posting." };
        set({ journalEntries: [...journalEntries, entry] });
        return { success: true, message: "Manual journal entry posted." };
      },

      reverseJournalEntry: (entryId: string) => {
        const { journalEntries } = get();
        const original = journalEntries.find((entry) => entry.id === entryId);
        if (!original) return { success: false, message: "Entry not found." };
        if (original.is_reversed) return { success: false, message: "This entry has already been reversed." };
        const reversal: JournalEntry = {
          id: `je-${Date.now()}-rev`,
          entry_number: `JE-${journalEntries.length + 1}`,
          date: new Date().toISOString(),
          description: `Reversal of ${original.entry_number}: ${original.description}`,
          source_type: "reversal",
          source_id: original.id,
          lines: original.lines.map((line) => ({ account_id: line.account_id, debit: line.credit, credit: line.debit })),
          is_reversed: false,
          created_at: new Date().toISOString(),
        };
        set({
          journalEntries: [
            ...journalEntries.map((entry) => entry.id === entryId ? { ...entry, is_reversed: true } : entry),
            reversal,
          ],
        });
        return { success: true, message: `${original.entry_number} reversed via ${reversal.entry_number}.` };
      },
    })
);
