# Kore Bench Database Setup (Postgres / Neon)

Kore Bench connects straight to a plain Postgres database (we use [Neon](https://neon.tech)) via the `pg` driver. There is no Supabase, no Docker, and no PostgREST layer — the Next.js server is the only thing that talks to the database, and it enforces tenant isolation itself (see the RLS note below).

## 1. Set your connection string

Create `.env.local` in the repo root (already gitignored) with at least:

```env
DATABASE_URL=postgres://user:password@host/dbname?sslmode=require
SESSION_SECRET=<64-char hex, see below>
LOCAL_API_TOKEN=<long random token>
```

Generate random secrets with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

See `.env.example` for the full list of variables.

### Daraja credentials in the server environment (single outlet)

For a single-property deployment, Daraja can be configured from the server's ignored `.env.local` file instead of the Property Settings form. This configuration is explicitly bound to one property and outlet; it is not returned to the browser and takes precedence over database Daraja settings for that exact pair. Do not commit this file or copy its secrets into chat.

On the server, find the IDs for the property and its restaurant outlet:

```bash
sudo -u postgres psql -d kore_bench -c "
SELECT p.id AS property_id, o.id AS outlet_id, p.name AS property, o.name AS outlet
FROM properties p
JOIN outlets o ON o.property_id = p.id
ORDER BY p.name, o.name;"
```

Configure Daraja for each property outlet in **Property Settings → M-Pesa / Daraja Configuration**. Consumer credentials, passkey, shortcode, environment, and callback URL are stored per outlet; credentials and the generated callback secret are encrypted at rest. The server must have `DARAJA_CONFIG_ENCRYPTION_KEY` set to a 32-byte hexadecimal key to save or read encrypted credentials. This key protects the database credentials and is not a shared Daraja account configuration.

## 2. Apply migrations

SQL schema files live in `db/migrations/*.sql`, applied in filename order and tracked in a `schema_migrations` table so re-runs are safe:

```powershell
npm run db:migrate
```

The public landing-page demo form stores contact details in `marketing_leads` via `POST /api/leads`; it records sales leads only and does not create user accounts. Apply the migrations before enabling lead capture.

Migration `036_one_open_shift_per_outlet_area.sql` enforces one open shift per outlet and work area. Stations within the same outlet share a shift; separate outlets (such as a restaurant, bar, gym, or front desk) have separate shifts. If the migration reports existing duplicate open shifts, close those shifts before rerunning `npm run db:migrate`.

### DigiTax catalog registration

Apply migrations before deploying code that adds or changes database-backed features. Migration `032_digitax_catalog_registration.sql` stores each catalog item's DigiTax profile, registration ID, and sync status.

In the app, enable DigiTax and save the sandbox API key in Property Settings. Add sale items in **Catalog** using an active, completed DigiTax profile: finished products require stock tracking, while services are non-stock items. KoreBench assigns the SKU as the barcode and registers the item with DigiTax. Check the per-item sync status; use **Sync KoreBench items to DigiTax** or the item's retry action if registration is pending or failed. The reverse **Import items from DigiTax** flow remains available for products already registered there and requires a barcode for safe matching.

### Restaurant eTIMS issuing permission

Only a role explicitly assigned **Issue eTIMS receipts** (`restaurant:fiscalize`) can issue a paid restaurant bill to DigiTax. In **Roles & Permissions**, create an **eTIMS Issuer** role with that permission and assign it only to the designated staff member. A wildcard administrator role does not implicitly grant fiscal signing. The issuer can review settled bills in Restaurant & Bar, confirm optional customer details, issue the receipt, and reprint or verify a confirmed receipt. Pending or unknown issues must be verified with DigiTax before retrying.

### Casual payroll

Migration `033_casual_payroll.sql` creates a property-scoped casual worker register and weekly payroll folios. The **Casual Payroll** workspace lets administrators and accountants maintain worker IDs, departments, phone numbers, daily rates, and active status; record attendance for each Sunday-to-Saturday day; and track deductions, partial or full payments, worker signatures, notes, department subtotals, balances owed, and folio sign-offs. Use **Print / Export PDF** on a weekly folio to open the browser print dialog; print it directly or choose **Save as PDF**. Folio numbers are generated per property. The migration and role setup grant `payroll:manage` to administrator and accountant roles; administrator roles with full (`*`) permissions already have access. Apply migrations before using this workspace.

## 3. Bootstrap your real company

There is no seed/demo data. Run the interactive bootstrap script once against your empty database to create your actual company, property, outlet, till station, roles, and admin (and optionally cashier) login:

```powershell
npm run db:bootstrap
```

You'll be prompted for real values (company name, property/outlet names, admin email + password, etc.) — nothing is invented for you.

## 4. Sign in

Once bootstrapped, log in at `/login` with the admin email/password you entered. From there you can create additional roles/users as the relevant admin screens are wired up (tracked separately — see project notes on staged rollout).

Cashier sessions reserve every outlet covered by the cashier's assignments until logout or session expiry. A second cashier cannot sign in while any of those outlets are reserved. Cashiers already signed in when this restriction is deployed must sign in again to establish their outlet reservations. POS and reservation shifts remain separate, and each outlet can have only one recorded shift per area, business date, and period.

## Tenant isolation (RLS) without Supabase Auth

Since there's no `auth.uid()` / PostgREST layer, every table still has Postgres Row-Level Security enabled, but the policies key off a session-local variable, `app.current_user_id`, instead. The server sets this with `SELECT set_config('app.current_user_id', '<user id>', true)` inside the same transaction as each authenticated request (see `withUserContext()` in `src/lib/db/postgres.ts`) so a bug in application code can't accidentally leak another tenant's rows — the database still blocks it.

## Adding more migrations

Add new files to `db/migrations/` with the next sequential number prefix (e.g. `010_something.sql`) and re-run `npm run db:migrate`; only new files are applied.
