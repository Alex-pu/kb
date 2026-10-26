# SME Hospitality & Retail Operations Platform — Build Specification

> **Implementation note:** The original spec below describes Supabase as the backend platform. The actual implementation uses plain PostgreSQL (hosted on Neon) with Next.js API routes doing auth, RLS context, and business logic directly — no Supabase, no Docker. See [DATABASE_SETUP.md](DATABASE_SETUP.md) for the current setup. The Row-Level Security / multi-tenancy goals described here still apply; only the auth/realtime/storage/edge-function parts of Supabase were dropped.

**Purpose of this document:** This is the authoritative scope and sequencing document for building this product with GitHub Copilot (or any AI pair-programmer). Each phase below is self-contained: it lists exactly what to build, what UI components are needed, what data it touches, and what is explicitly **out of scope** for that phase. When feeding a phase to Copilot, paste that phase section (plus the "Non-Negotiable Principles" and "Tech Stack" sections for context) rather than the whole document, so Copilot does not wander into later-phase scope.

**Do not build ahead of the current phase.** Every phase must pass its exit criteria before the next begins.

---

## 1. Product Vision

A single operations platform for Kenyan SMEs — hotels, restaurants, bars, and retail shops — that unifies:

- **Point of Sale** (retail shop counter + restaurant/bar table service)
- **Small Property Management System** (rooms, bookings, folios, housekeeping)
- **HR** (staff, shifts, attendance, basic payroll with Kenyan statutory deductions)
- **Accounting** (chart of accounts, journal postings from operations, expenses, financial reports)
- **Controls & Audit** (approvals, variance tracking, full audit trail — nothing is edited after posting, only reversed)

The product must work reliably on inconsistent connectivity, support M-Pesa/Airtel Money alongside cash and card, and let each business (tenant/property) configure itself — menus, rooms, taxes, roles — **without a developer**, while structural changes remain a developer/vendor task.

---

## 2. Non-Negotiable Principles

These apply to every phase, without exception. Copilot should treat violations of these as bugs, not style choices.

1. **Tenant isolation is enforced in the database, not the UI.** Every table with business data carries a `property_id` (and `outlet_id` where relevant). Row-Level Security (RLS) policies — not application-level `if` checks — are the actual security boundary. A user from Property A must get zero rows back from Property B even if they call the API directly.
2. **UI hiding is not authorization.** Every button, API route, background job, and report must independently re-check role + assignment scope server-side.
3. **Financial and kitchen documents are never mutated after posting.** Corrections happen via a linked reversal/void document with a reason and approver, never by editing the original row.
4. **Every mutating action is idempotent.** Retried network calls, double-clicks, or printer retries must not create duplicate orders, KOTs, payments, or folio postings. Use idempotency keys on all POST-type actions that touch money or stock.
5. **Every operational action is traceable**: user, role, outlet/station, shift, source document, reason (where applicable), and timestamp.
6. **Approvals are data, not code.** Thresholds for discounts, voids, refunds, and overrides live in a configuration table read at runtime, so a hotel can change "requires manager approval above 500 KES" without a deploy.
7. **Offline is a contract, not an afterthought**, but it is scheped for Phase 10 (see roadmap). Do not silently drop it from earlier phases' data model — always include timestamps/idempotency keys that offline sync will later depend on.

---

## 3. Tech Stack & Tool Choices

| Layer | Choice | Why |
|---|---|---|
| Database | **PostgreSQL** (via Supabase) | Relational integrity for financial data; native Row-Level Security for multi-tenancy. |
| Backend platform | **Supabase** (Postgres + Auth + Realtime + Storage + Edge Functions) | Removes the need to hand-build auth, realtime websockets, and file storage. RLS gives tenant isolation at the DB layer. |
| Internal admin (vendor-facing, schema-level) | **Directus**, pointed at the same Postgres DB | Lets your own team add tables/fields/relations and internal reports visually, without a redeploy. This is *not* exposed to hotels/shops. |
| Tenant-facing configuration ("no-code for the customer") | **Custom "Property Settings" module inside the main app** | A curated set of validated forms (tax rates, rooms, menu, approval thresholds, roles) scoped by RLS to one property. No raw schema access — see Section 6. |
| Operational frontend (POS, KDS, Room Rack, Floor Plan, Cashier) | **Next.js (React) PWA**, TypeScript, Tailwind | Needs bespoke, fast, touch-first UX and offline resilience that no low-code tool handles well. Service worker + IndexedDB for offline queueing. |
| Business/workflow logic (approvals, room-charge flow, shift close, KDS transitions) | **Supabase Edge Functions** (Deno/TypeScript) or a small **NestJS/FastAPI service** if the team prefers a conventional server | Owns transition legality and idempotency — logic too stateful for DB triggers alone. |
| Simple invariants (balance calcs, stock deduction, timestamps) | **Postgres functions/triggers** | Cheaper and more reliable than round-tripping through the app for simple arithmetic. |
| Payments | **M-Pesa Daraja API**, **Airtel Money API**, cash, card (via a payment gateway partner e.g. Pesapal/Flutterwave for card) | Kenyan market requirement. |
| Fiscal compliance | **KRA eTIMS** integration | Required for VAT-registered SME invoicing in Kenya. |
| Hosting | Supabase managed Postgres + a Node hosting target for Next.js (Vercel, Fly.io, or self-hosted VPS depending on data-residency preference) | Keep infra simple to start; revisit only if compliance requires local hosting. |
| Reporting/BI (internal, optional) | Directus's built-in insights or a lightweight charting layer inside the app | Avoid standing up a separate BI tool until there's real demand. |

**Explicitly rejected for this build:** Frappe/bench (too rigid for the custom real-time operational screens this product needs), fully low-code app builders like Retool/Appsmith/Budibase for the *operational* screens (fine for internal dashboards only, not for POS/KDS/Room Rack).

---

## 4. System Architecture (Two-Tier Admin Model)

```
                     ┌─────────────────────────┐
                     │   Postgres (Supabase)    │
                     │  RLS-scoped by property   │
                     └────────────┬─────────────┘
                                  │
        ┌─────────────────────────┼───────────────────────────┐
        │                         │                           │
┌───────▼────────┐      ┌─────────▼─────────┐      ┌──────────▼──────────┐
│    Directus     │      │  Next.js PWA App    │      │  Edge Functions /    │
│  (vendor-only)   │      │ (all tenant users)  │      │  workflow service    │
│  schema, internal│      │ POS, KDS, Room Rack, │      │  approvals, KOT      │
│  reports, master │      │ Cashier, Reports,    │      │  transitions, room-  │
│  data seeding    │      │ Property Settings    │      │  charge flow         │
└──────────────────┘      └──────────────────────┘      └──────────────────────┘
```

- **Directus** is never given credentials by a hotel/shop user. It's an internal build/ops tool.
- **Property Settings** inside the Next.js app is the *only* configuration surface hotel/shop IT staff touch. It writes to the same tables Directus can see, but through validated forms only (dropdowns, bounded numeric inputs — never raw JSON/table editors).
- **New behavior** (new screens, new states, new integrations) is always code, shipped by the vendor. **New parameters** (a new room type, a new discount threshold, a new tax rate) are config, editable by the tenant.

---

## 5. Core Data Model (High-Level Entities)

This is the entity list every phase builds against. Exact column-level schema is generated per phase, but names and relationships should stay consistent throughout so Copilot doesn't invent conflicting models.

**Tenancy & Identity**
`companies` (top-level SME account) → `properties` (a hotel or shop location) → `outlets` (a restaurant, bar, front desk, or shop counter within a property) → `stations` (a POS till, a kitchen prep station)

`users`, `roles`, `user_assignments` (user × property × outlet × station × role × effective dates × approval limits)

**Catalog**
`categories`, `items` (menu items or retail SKUs — unified table with a `type` discriminator), `modifiers`, `price_lists`, `packages`

**Retail/POS**
`orders`, `order_lines`, `payments`, `tenders`, `discounts`, `voids_refunds` (linked reversal docs), `shifts` (cashier shift open/close)

**Hospitality**
`rooms`, `room_types`, `rate_plans`, `bookings`, `stays`, `folios`, `folio_lines`, `housekeeping_status_log`

**Restaurant/Bar**
`floor_areas`, `tables`, `table_status_log`, `kots` (kitchen order tickets), `kot_lines`, `kot_status_log`, `prep_stations`

**Stock**
`stock_items`, `stock_levels` (per outlet), `requisitions`, `transfers`, `wastage_adjustments`, `purchase_receipts`, `suppliers`

**HR**
`employees`, `employment_contracts`, `attendance_records`, `shift_schedules`, `payroll_runs`, `payslips`, `statutory_deductions` (NSSF, SHA, PAYE, Housing Levy)

**Accounting**
`chart_of_accounts`, `journal_entries`, `journal_lines`, `expenses`, `bank_cash_accounts`, `tax_rates`

**Controls & Audit**
`approval_policies` (action type × threshold × required role — config table), `approval_requests`, `audit_log` (append-only: actor, action, source document, before/after where relevant, timestamp)

---

## 6. Configuration vs. Code Boundary (Reference for All Phases)

When building any feature, classify it before writing code:

| If it's... | It belongs in... |
|---|---|
| A tax rate, room rate, menu price, discount threshold | `Property Settings` config table |
| A new room/table/floor/menu item | `Property Settings` (tenant self-service) |
| Role-to-user assignment | `Property Settings` |
| Receipt/print template content | `Property Settings` (templated fields, not free code) |
| A brand-new workflow step (e.g., adding a "Manager Pre-Authorization" stage to check-in) | Code change, vendor-shipped |
| A new report type or dashboard | Code change |
| A new payment gateway or fiscal integration | Code change |
| Internal master data / vendor-side schema tweaks | Directus (vendor-only) |

---

## 7. Build Roadmap — Increments

Each phase lists: **Goal**, **Functionality**, **UI Components**, **Data touched**, **Exit Criteria**, and **Out of Scope** (explicitly excluded so Copilot doesn't over-build).

---

### Phase 0 — Foundation & Multi-Tenant Skeleton

**Goal:** Nothing customer-visible yet. Prove tenant isolation and auth work before any feature is built on top.

**Functionality**
- Supabase project provisioned; Postgres schema for `companies`, `properties`, `outlets`, `users`, `roles`, `user_assignments`.
- RLS policies on every table scoped by `property_id`, tested with at least two dummy properties.
- Supabase Auth wired up (email/password + phone OTP for Kenyan staff who may not have email).
- Next.js app shell: login, property switcher (for users assigned to multiple properties), empty authenticated shell layout.
- Directus installed and pointed at the same Postgres instance, restricted to vendor team logins only.

**UI Components**
- Login screen
- Property/outlet selector (only shown if user has >1 assignment)
- Empty dashboard shell with left navigation skeleton (matching Section 8 nav structure, all links disabled/"coming soon")

**Data touched:** Tenancy & Identity tables only.

**Exit Criteria**
- A user assigned only to Property A cannot fetch, list, or receive realtime events for Property B's rows via direct API calls (tested, not assumed).
- A second disposable test property can be provisioned and torn down cleanly.

**Out of Scope:** Any POS, room, or accounting feature. No payments. No reports.

---

### Phase 1 — Retail Shop POS (MVP)

**Goal:** A shop counter can ring up a sale end-to-end. This is the simplest full vertical slice and proves the core order → payment → stock pattern before hospitality complexity is added.

**Functionality**
- Item catalog CRUD (via Property Settings): name, price, category, barcode, stock-tracked flag.
- POS screen: browse/search items, add to cart, apply a simple discount (policy-gated), checkout.
- Cash and M-Pesa (manual reference entry first; Daraja API integration can follow in a sub-increment) payment capture.
- Receipt generation (print or share via WhatsApp/SMS link).
- Stock auto-decrements on sale for stock-tracked items.
- Basic cashier shift open (opening float) / close (expected vs. counted cash) for this single till.

**UI Components**
- `Touch POS Station` screen: category tabs, item grid, search bar, cart panel, numeric keypad for quantity, payment modal (tender selector), receipt preview.
- `Shift Open` modal (opening float by tender).
- `Shift Close` screen (expected vs. counted, variance flag).
- `Items` management screen (list + add/edit form) inside Property Settings.

**Data touched:** Catalog, `orders`, `order_lines`, `payments`, `tenders`, `shifts`, `stock_items`, `stock_levels`.

**Exit Criteria**
- A cashier can open a shift, complete 3 different sales with mixed tenders, close the shift, and the counted-vs-expected math is correct and immutable once posted.
- Stock levels reflect sales accurately.
- Retrying a payment submission (simulated double-click) does not create a duplicate order.

**Out of Scope:** Hotel/room features, KDS, tables, HR, accounting journal postings (stock/sales just update their own tables for now — full double-entry accounting comes in Phase 7), multi-outlet.

---

### Phase 2 — Restaurant/Bar: Floor Plan, Tables & Order Flow

**Goal:** Extend POS from single-till retail to table-service, without kitchen display yet.

**Functionality**
- Floor area and table setup (Property Settings): areas, tables, seating capacity.
- Table-based ordering: start order at a table, add items/modifiers/notes, hold cart across navigation/refresh.
- Table status lifecycle: Available → Occupied → Bill Requested → Payment Pending → Cleaning → Available.
- Bill/settlement flow reusing Phase 1's payment capture, now against a table instead of a walk-in cart.
- Table transfer and check merge/split (policy-gated).

**UI Components**
- `Floor Plan & Tables` screen: visual grid/map of tables by area, color-coded by status.
- `Table detail` panel: current order, add items, request bill, transfer, merge/split actions.
- Extend `Touch POS Station` to support "dine-in" context alongside "walk-in."

**Data touched:** `floor_areas`, `tables`, `table_status_log`, `orders` (now linked to `table_id`), `order_lines`.

**Exit Criteria**
- A waiter can open a table, add items in two separate rounds, and the system does not lose the cart on refresh.
- Table status updates correctly reflect order state and are driven by actual order events, not manual free-text.

**Out of Scope:** Kitchen Display System (Phase 3), room charges (Phase 4), HR, accounting.

---

### Phase 3 — Kitchen Display System (KDS)

**Goal:** Orders placed at tables (or rooms, once Phase 4 exists) route to the correct kitchen/bar station with correct ticket lifecycle.

**Functionality**
- KOT generation: only new/changed line items are sent as a ticket (delta KOTs), not the whole order each time.
- Station routing based on item's assigned prep station.
- Ticket state machine: New → Accepted → Preparing → Ready → Served (plus Cancelled, with reason).
- Server-side ownership of transition legality — the KDS client cannot directly edit an order, only transition ticket state.
- Aging indicators and threshold warnings.

**UI Components**
- `Kitchen Display System` screen: filterable by station (All/Kitchen/Bar), ticket cards with age, items, modifiers, notes, next-action button, full-screen mode.
- Waiter-side: KOT number and status badge visible on the table/order view from Phase 2.

**Data touched:** `kots`, `kot_lines`, `kot_status_log`, `prep_stations`.

**Exit Criteria**
- A waiter adds items in two rounds; kitchen sees two correctly-scoped delta tickets, not a duplicated full order.
- A ticket cannot skip an illegal state transition (e.g., New → Served) even via a manipulated API call.
- Retrying a "send to kitchen" action does not duplicate ticket line quantities.

**Out of Scope:** Room service KOTs specifically (fold in naturally once Phase 4 rooms exist, but don't build ahead), stock/recipe consumption from KOTs (Phase 6/food-cost is later).

---

### Phase 4 — Front Desk & Rooms (Small PMS Core)

**Goal:** Hotel side of the product — rooms, bookings, check-in/out, folios — reusing the payment/shift infrastructure already built.

**Functionality**
- Room and room-type setup (Property Settings): rooms, categories, rate plans.
- Live Room Rack: room tiles with status (Available, Occupied, Reserved, Dirty/Cleaning, Maintenance, Inspected).
- Booking creation, check-in, check-out.
- Folio: itemized guest account, auto-populated by room charges and (once wired) restaurant charges.
- Housekeeping status updates (Dirty → Clean → Inspected), with check-in blocked on an uninspected/unavailable room.
- Bookings & Folios register: search/filter by guest, phone, booking ref, room, status.

**UI Components**
- `Live Room Rack` screen: room tiles, filters (floor, type, status, date), status-appropriate action buttons.
- `Bookings & Folios` register: searchable/filterable table with actions (open, check-in, check-out, print, record payment).
- `Booking detail / Folio` view: itemized charges, balance due, payment history.
- `Housekeeping` screen: simple status board per room.

**Data touched:** `rooms`, `room_types`, `rate_plans`, `bookings`, `stays`, `folios`, `folio_lines`, `housekeeping_status_log`.

**Exit Criteria**
- A receptionist can search a guest by phone, open a booking, assign a clean+inspected room, check in, view the folio, post a manual service charge, receive payment, and check out — end to end.
- A room cannot be checked into while Dirty or Maintenance status.
- Folio balance is always calculated from `folio_lines` + `payments`, never a free-text/UI-only number.

**Out of Scope:** Room-charge-from-restaurant flow (Phase 5), HR, full accounting journal postings.

---

### Phase 5 — Room Charge Control Flow & Cashier Shift Hardening

**Goal:** Connect restaurant/bar billing to hotel folios with proper custody and approval controls — this is the highest-risk workflow in the whole spec (money can leak here) so it gets its own phase.

**Functionality**
- Cashier requests room charge against an active stay from a restaurant/bar bill.
- Server validates: active stay, open folio, no-post policy, credit limit, property/outlet match.
- Request enters **Pending Reception**; a *different* user (receptionist) must accept before any folio posting occurs.
- Acceptance creates one idempotent folio entry linked to the source order.
- Rejection returns custody to the cashier shift (if still open) or triggers supervisor custody handover with a reason if the shift is closing.
- Cashier shift close screen upgraded: expected vs. counted by tender, room-charge activity, refunds, voids, discounts, reprints, unresolved exceptions — manager approval required above configured variance threshold.
- Approval policy config (Property Settings): thresholds for discounts, voids, refunds, overrides, room-charge sign-off.

**UI Components**
- `Room Charge Request` modal (cashier side) and `Pending Room Charges` queue (reception side) with accept/reject + reason.
- Enhanced `Shift Close` screen: full reconciliation breakdown, blind count entry, exception list, manager sign-off flow.
- `Approval Policies` screen in Property Settings (action × threshold × required role table).

**Data touched:** `folios`, `folio_lines`, `approval_policies`, `approval_requests`, `shifts`, `audit_log`.

**Exit Criteria**
- A room-charge request remains pending until a *different* authorized receptionist accepts it; retrying the accept action does not duplicate the folio entry.
- A supervisor can approve a reasoned void/refund and the reversal is a linked document, never a mutation of the original.
- A shift cannot close with unresolved room-charge custody silently dropped.

**Out of Scope:** HR, formal double-entry accounting (that's Phase 7 — this phase's folio/cash postings are still operational records, not yet GL entries).

---

### Phase 6 — Stock & Supplies

**Goal:** Real inventory control across both retail and F&B, feeding into food-cost reporting later.

**Functionality**
- Stock levels per outlet, requisitions between outlets/central store, transfers, wastage/adjustment logging (with reason), purchase receiving against suppliers.
- Low-stock alerts (threshold configurable per item in Property Settings).
- Recipe/BOM linkage for menu items (so a sold dish deducts constituent raw stock) — introduced here as data model, consumption logic refined in Phase 9 reporting.

**UI Components**
- `Stock Levels` screen (by outlet, filterable).
- `Requisitions` and `Transfers` screens (create, approve, receive).
- `Wastage & Adjustments` form (item, quantity, reason, photo optional).
- `Purchase Receiving` screen against supplier POs.
- `Low Stock Alerts` panel (feeds into Command Center in Phase 8).

**Data touched:** `stock_items`, `stock_levels`, `requisitions`, `transfers`, `wastage_adjustments`, `purchase_receipts`, `suppliers`.

**Exit Criteria**
- Stock movements from Phase 1 (retail sale) and Phase 3 (KOT-linked recipe items, if configured) correctly decrement stock.
- A negative/suspicious stock balance is flagged, not silently allowed.

**Out of Scope:** Full theoretical-vs-actual food cost analytics (Phase 9), HR, accounting GL.

---

### Phase 7 — HR & Basic Payroll (Kenya-Specific)

**Goal:** Staff records, attendance/shifts, and payroll with correct Kenyan statutory deductions — largely independent of the operational modules above, but shares the `users`/`user_assignments` base from Phase 0.

**Functionality**
- Employee records (distinct from system login `users`, though linked where an employee is also a POS/system user), contracts, basic/gross pay.
- Shift scheduling and attendance capture (clock-in/out, tied to `stations`/`outlets` from Phase 0 for hourly retail/hospitality staff).
- Payroll run: gross → PAYE, NSSF, SHA (Social Health Authority), Affordable Housing Levy → net pay.
- Payslip generation.

**UI Components**
- `Employees` screen (list + profile: contract, pay rate, statutory numbers).
- `Attendance` screen (clock-in/out log, shift roster view).
- `Payroll Run` wizard (select period → review calculated deductions → approve → generate payslips).
- `Payslip` view/download.

**Data touched:** `employees`, `employment_contracts`, `attendance_records`, `shift_schedules`, `payroll_runs`, `payslips`, `statutory_deductions`.

**Exit Criteria**
- A payroll run for a test set of employees produces correct PAYE/NSSF/SHA/Housing Levy figures against current published Kenyan rates (rates themselves stored as configurable, dated records — not hardcoded — since statutory rates change).
- Attendance correctly ties to shift schedules and flags no-shows/lateness.

**Out of Scope:** Deep leave management, performance reviews, recruitment — keep HR to what an SME actually needs operationally (attendance + payroll), not a full HRIS, unless later requested.

---

### Phase 8 — Accounting (Double-Entry Core)

**Goal:** Everything operational so far (sales, folios, expenses, payroll) posts into a real chart of accounts with double-entry integrity.

**Functionality**
- Chart of accounts setup (Property Settings, with sensible SME default template pre-seeded).
- Automatic journal posting triggers from: POS sales (Phase 1/2), folio settlements (Phase 4/5), stock movements (Phase 6 — COGS), payroll runs (Phase 7).
- Manual journal entry for anything not auto-posted (with approval policy gating for larger manual entries).
- Expense capture (with receipt photo attach) and categorization against the chart of accounts.
- Bank/cash account reconciliation basics.

**UI Components**
- `Chart of Accounts` management screen.
- `Journal Entries` register (auto-posted entries shown read-only with source-document links; manual entry form separately).
- `Expenses` capture form and list.
- `Cash/Bank Accounts` screen with reconciliation view.

**Data touched:** `chart_of_accounts`, `journal_entries`, `journal_lines`, `expenses`, `bank_cash_accounts`, `tax_rates`.

**Exit Criteria**
- A sale, a room folio settlement, and a payroll run each generate a correctly-balanced (debits = credits) journal entry automatically, linked back to their source document.
- No submitted journal entry can be edited — only reversed via a linked counter-entry.

**Out of Scope:** Multi-currency, full IFRS-depth reporting, tax filing automation beyond eTIMS invoicing hooks already noted in the stack.

---

### Phase 9 — Command Center Dashboard & Reports

**Goal:** Bring every module's data together into the management-facing dashboard and report suite described in the reference spec — this deliberately comes *after* the modules exist, since it has nothing to aggregate before then.

**Functionality**
- Hospitality & POS Command Center: period selector, property/outlet selector, KPI cards (occupancy, arrivals/departures, in-house guests, active tables, kitchen orders in prep, revenue, net liquidity, folios due, cashier variance, opex, low stock).
- Exception panels: unassigned arrivals, unpaid departures, dirty/uninspected rooms, aging KOTs, pending shift closes, pending room-charge approvals, unresolved voids/refunds/discounts, low stock, negative stock, revenue-leakage candidates, failed integration jobs.
- Full report suite: revenue by period/outlet/room/table/item/cashier/tender; occupancy & turnover; open/overdue folios; KOT volume & aging; cashier X/Z & variance; voids/refunds/discounts/reprints; stock movement & theoretical food cost; room-charge audit trail; integration failure log; full activity timeline linked to source documents.

**UI Components**
- `Command Center` dashboard (quick actions row, KPI card grid, exception panel list).
- `Reports` section: filterable, exportable report views per report type above.
- `Activity Logs` screen (searchable audit timeline).

**Data touched:** Read-only aggregation across all prior phases' tables; no new core entities except report-specific materialized views if needed for performance.

**Exit Criteria**
- Every exception panel item links through to its real source document and next permitted action.
- A manager can filter to a period+outlet and every KPI card is clickable through to its underlying filtered register.

**Out of Scope:** Predictive analytics/forecasting — this phase is operational reporting, not BI/ML.

---

### Phase 10 — Resilience: Offline, Multi-Property, Printer/Payment Health

**Goal:** Harden the product for real-world Kenyan connectivity and multi-location operators — deliberately last, per the original reference spec's own sequencing (offline is P2/optional-pilot, not core).

**Functionality**
- PWA offline order/KOT capture (service worker + IndexedDB) with conflict-safe sync on reconnect, using the idempotency keys already present from earlier phases.
- Printer and payment job health queue with automatic retry and visible failure state.
- Authorized multi-property aggregated view for operators running more than one site.
- Mobile-optimized station views for waiters/housekeeping.

**UI Components**
- Online/offline/sync status indicator (already present as a stub from Phase 0, now functional).
- `Integration Health` panel (printer/payment/fiscal/sync job statuses, retry action).
- `Multi-Property` aggregated dashboard view (extends Phase 9's Command Center with a property-group selector).

**Data touched:** Adds sync-state metadata to existing operational tables; no new business entities.

**Exit Criteria**
- Simulated network loss during an order, followed by restart and reconnect, produces exactly one correct order/KOT — not zero, not duplicated.
- A failed print/payment job is visible and successfully retryable without operator confusion.

**Out of Scope:** Anything not already built in Phases 0–9 — this phase only hardens existing functionality, it does not add new business features.

---

## 8. Reference Navigation Structure (Target State, Built Incrementally)

This is the *end-state* left navigation. Do not build all of it in Phase 0 — each item is enabled as its owning phase completes (noted in brackets).

1. Dashboard *(stub P0 → functional P9)*
2. User Management *(P0)*
3. Front Desk & Rooms *(P4)*
4. Restaurant & Bar *(P2/P3)*
5. Products & Menu Catalog *(P1, extended P2)*
6. Guests & Accounts *(P4)*
7. Stock & Supplies *(P6)*
8. HR *(P7)*
9. Accounting *(P8)*
10. Reports *(P9)*
11. Activity Logs *(P9)*
12. Property Settings *(introduced incrementally per phase — this is the tenant self-service config surface, see Section 6)*

---

## 9. Notes for Working with Copilot

- Feed Copilot **Sections 2, 3, and 6 every time** (principles, stack, config/code boundary) alongside whichever phase you're currently building — these are the guardrails that stop scope drift.
- When starting a new phase, explicitly tell Copilot: *"Only build what's listed under Functionality and UI Components for Phase N. Do not implement anything listed under Out of Scope."*
- If Copilot suggests a feature not listed in the current phase, check whether it belongs in a later phase (defer it) or is genuinely missing from this spec (add it here first, then implement) — don't let it get built ad hoc.
- Keep entity/table names consistent with Section 5 across all phases so later phases' foreign keys resolve cleanly.
