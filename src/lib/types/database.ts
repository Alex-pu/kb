export type PropertyType = 'hotel' | 'restaurant' | 'retail' | 'hybrid';
export type OutletType = 'retail_counter' | 'restaurant' | 'bar' | 'front_desk' | 'kitchen' | 'store';
export type StationType = 'pos_till' | 'kds_screen' | 'reception_terminal' | 'store_terminal';

export interface Company {
  id: string;
  name: string;
  tax_pin?: string;
  country_code: string;
  currency: string;
  created_at: string;
  updated_at: string;
}

export interface Property {
  id: string;
  company_id: string;
  name: string;
  code: string;
  property_type: PropertyType;
  physical_address?: string;
  phone_number?: string;
  email?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Outlet {
  id: string;
  property_id: string;
  name: string;
  code: string;
  outlet_type: OutletType;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Station {
  id: string;
  outlet_id: string;
  name: string;
  station_type: StationType;
  hardware_identifier?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Role {
  id: string;
  company_id?: string;
  name: string;
  role_key: string;
  description?: string;
  permissions: string[];
  is_system_role: boolean;
  created_at: string;
}

export interface User {
  id: string;
  supabase_auth_id?: string;
  company_id: string;
  full_name: string;
  email?: string;
  phone_number?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserAssignment {
  id: string;
  user_id: string;
  property_id: string;
  outlet_id?: string;
  station_id?: string;
  role_id: string;
  role?: Role;
  property?: Property;
  outlet?: Outlet;
  station?: Station;
  max_discount_percent: number;
  max_void_amount: number;
  can_override_approval: boolean;
  effective_from: string;
  effective_to?: string;
  is_active: boolean;
}

export interface AuditLogEntry {
  id: string;
  company_id: string;
  property_id?: string;
  outlet_id?: string;
  actor_user_id?: string;
  actor_name?: string;
  action_type: string;
  resource_type: string;
  resource_id?: string;
  payload_before?: Record<string, unknown>;
  payload_after?: Record<string, unknown>;
  ip_address?: string;
  created_at: string;
}

export type ProductCategory = "grocery" | "hardware" | "beverage" | "household" | "food";
export type TenderType = "cash" | "mpesa" | "card";
export type ShiftStatus = "open" | "closed";
export type ShiftArea = "pos" | "reservation";
export type ShiftPeriod = "morning" | "evening";
export type CatalogItemType = "retail" | "menu" | "supply";

export interface CatalogItem {
  id: string;
  item_type?: CatalogItemType;
  property_id: string;
  outlet_id: string;
  name: string;
  sku: string;
  unit?: string;
  barcode?: string;
  category: ProductCategory;
  price: number;
  stock: number;
  stock_available?: boolean;
  reorder_level: number;
  stock_tracked: boolean;
  is_active: boolean;
  prep_station?: "kitchen" | "bar";
  etims_item_code?: string | null;
  etims_tax_code?: string | null;
  etims_item_class_code?: string | null;
  stock_by_warehouse?: {
    kitchen: number;
    bar: number;
    supplies?: number;
  };
}

export interface CartLine {
  item: CatalogItem;
  quantity: number;
}

export interface TenderLine {
  type: TenderType;
  amount: number;
  reference?: string;
}

export interface DarajaShopConfig {
  id: string;
  property_id: string;
  outlet_id?: string;
  enabled: boolean;
  environment: "sandbox" | "production";
  short_code: string;
  consumer_key: string;
  consumer_secret: string;
  passkey: string;
  callback_url: string;
  timeout_url: string;
  created_at: string;
  updated_at: string;
}

export interface DarajaPaymentRecord {
  id: string;
  property_id: string;
  outlet_id?: string;
  order_id: string;
  bill_reference?: string;
  amount: number;
  transaction_code: string;
  checkout_request_id?: string;
  payer_phone?: string;
  status: "pending" | "paid" | "failed" | "timeout";
  callback_payload?: Record<string, unknown>;
  applied_at?: string;
  created_at: string;
  updated_at: string;
}

export interface RetailShift {
  id: string;
  outlet_id: string;
  station_id: string;
  cashier_id: string;
  shift_area: ShiftArea | null;
  shift_period: ShiftPeriod | null;
  business_date: string | null;
  opening_float: number;
  cash_sales: number;
  status: ShiftStatus;
  opened_at: string;
  closed_at?: string;
  counted_cash?: number;
  variance?: number;
  manager_approval_required?: boolean;
}

export interface RetailReceipt {
  receipt_number: string;
  order_id: string;
  issued_at: string;
  cashier_name: string;
  lines: CartLine[];
  tenders: TenderLine[];
  total: number;
}

export type TableStatus = "available" | "occupied" | "bill_requested" | "payment_pending" | "cleaning";

export interface FloorArea {
  id: string;
  property_id: string;
  outlet_id: string;
  name: string;
}

export interface RestaurantTable {
  id: string;
  floor_area_id: string;
  outlet_id: string;
  property_id: string;
  name: string;
  capacity: number;
  status: TableStatus;
}

export interface TableOrderLine {
  item: CatalogItem;
  quantity: number;
  round: number;
  sentToKitchen: boolean;
  instructions?: string;
}

export type KotStatus = "new" | "accepted" | "preparing" | "ready" | "served" | "cancelled";
export type PrepStation = "kitchen" | "bar";

export interface KotLine {
  item: CatalogItem;
  quantity: number;
  instructions?: string;
}

export interface Kot {
  id: string;
  check_id: string;
  table_id: string;
  table_name: string;
  round: number;
  station: PrepStation;
  status: KotStatus;
  lines: KotLine[];
  created_at: string;
  cancel_reason?: string;
  archived_at?: string;
}

export type RoomStatus = "available" | "occupied" | "reserved" | "maintenance";
export type HousekeepingStatus = "dirty" | "cleaning" | "ready";
export type MealAddOn = "breakfast" | "lunch";
export type BookingStatus = "reserved" | "checked_in" | "checked_out" | "cancelled";
export type FolioLineType = "room_charge" | "service_charge" | "payment";

export interface RoomType {
  id: string;
  property_id: string;
  name: string;
  rate_per_night: number;
}

export interface Room {
  id: string;
  property_id: string;
  room_type_id: string;
  number: string;
  floor: string;
  status: RoomStatus;
  housekeeping_status: HousekeepingStatus;
  housekeeping_updated_at?: string;
  housekeeping_updated_by_name?: string;
  housekeeping_checklist?: Partial<Record<"cleanliness" | "linens" | "bathroom" | "amenities" | "maintenance", boolean>>;
  housekeeping_notes?: string;
}

export interface Guest {
  id: string;
  full_name: string;
  phone_number: string;
  id_number?: string;
}

export interface Booking {
  id: string;
  property_id: string;
  room_id: string;
  guest: Guest;
  check_in_date: string;
  check_out_date: string;
  status: BookingStatus;
  folio_id: string;
  guest_count?: number;
  meal_add_ons?: Partial<Record<MealAddOn, number>>;
  actual_check_in?: string;
  actual_check_out?: string;
}

export interface FolioLine {
  id: string;
  type: FolioLineType;
  description: string;
  amount: number;
  created_at: string;
  reference?: string;
}

export interface Folio {
  id: string;
  booking_id: string;
  lines: FolioLine[];
}

export type RoomChargeStatus = "pending" | "approved" | "rejected";

export interface RoomChargeRequest {
  id: string;
  check_id: string;
  outlet_id: string;
  table_id: string;
  table_name: string;
  booking_id: string;
  folio_id: string;
  guest_name: string;
  amount: number;
  requested_by_user_id: string;
  requested_by_name: string;
  status: RoomChargeStatus;
  reason?: string;
  created_at: string;
  resolved_at?: string;
  resolved_by_user_id?: string;
}

export interface ApprovalPolicy {
  id: string;
  action_type: "discount" | "void" | "refund" | "shift_variance" | "room_charge_signoff";
  label: string;
  threshold: number;
  required_role: string;
}

export interface Supplier {
  id: string;
  property_id: string;
  name: string;
  phone_number?: string;
}

export interface StockItem {
  id: string;
  property_id: string;
  name: string;
  sku: string;
  item_type: CatalogItemType;
  unit: string;
  reorder_level: number;
  stock_tracked: boolean;
  prep_station: "kitchen" | "bar";
  available_at_outlet: boolean;
  central_quantity: number;
  kitchen_quantity: number;
  bar_quantity: number;
  supplies_quantity: number;
}

export type StockMovementType = "purchase_receipt" | "stock_transfer" | "wastage" | "pos_sale" | "restaurant_sale" | "opening_balance";
export type StockWarehouse = "central" | "kitchen" | "bar" | "supplies";

export interface StockMovement {
  id: string;
  movement_type: StockMovementType;
  item_id: string;
  item_name: string;
  unit: string;
  quantity: number;
  source_outlet_name?: string;
  source_warehouse?: StockWarehouse;
  destination_outlet_name?: string;
  destination_warehouse?: StockWarehouse;
  supplier_name?: string;
  unit_cost?: number;
  reason?: string;
  actor_name: string;
  created_at: string;
}

export type StockRequisitionStatus = "pending" | "partially_fulfilled" | "fulfilled" | "rejected" | "cancelled";

export interface StockRequisitionLine {
  item_id: string;
  item_name: string;
  unit: string;
  quantity_requested: number;
  quantity_fulfilled: number;
}

export interface StockRequisition {
  id: string;
  outlet_id: string;
  outlet_name: string;
  destination_warehouse: Exclude<StockWarehouse, "central">;
  requester_id: string;
  requester_name: string;
  status: StockRequisitionStatus;
  note?: string;
  rejection_reason?: string;
  created_at: string;
  resolved_at?: string;
  resolved_by_name?: string;
  lines: StockRequisitionLine[];
}

export interface StockTransfer {
  id: string;
  stock_item_id: string;
  from_outlet_id: string;
  to_outlet_id: string;
  quantity: number;
  created_by_name: string;
  created_at: string;
}

export interface WastageEntry {
  id: string;
  stock_item_id: string;
  outlet_id: string;
  quantity: number;
  reason: string;
  created_by_name: string;
  created_at: string;
}

export interface PurchaseReceipt {
  id: string;
  stock_item_id: string;
  outlet_id: string;
  supplier_id: string;
  quantity: number;
  unit_cost: number;
  created_at: string;
}

export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

export interface ChartOfAccount {
  id: string;
  code: string;
  name: string;
  type: AccountType;
}

export interface JournalLine {
  account_id: string;
  debit: number;
  credit: number;
}

export interface JournalEntry {
  id: string;
  entry_number: string;
  date: string;
  description: string;
  source_type: "pos_sale" | "folio_settlement" | "purchase_receipt" | "expense" | "manual" | "reversal";
  source_id?: string;
  lines: JournalLine[];
  is_reversed: boolean;
  reversed_entry_id?: string;
  created_at: string;
}

export interface Expense {
  id: string;
  description: string;
  amount: number;
  account_id: string;
  category: string;
  created_at: string;
}
