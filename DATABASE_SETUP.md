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

Set the following values in the server's `.env.local`, replacing the IDs and Daraja values with your own:

```env
DARAJA_PROPERTY_ID=<property UUID>
DARAJA_OUTLET_ID=<restaurant outlet UUID>
DARAJA_ENABLED=true
DARAJA_ENVIRONMENT=sandbox
DARAJA_SHORT_CODE=<Daraja shortcode>
DARAJA_CONSUMER_KEY=<Daraja consumer key>
DARAJA_CONSUMER_SECRET=<Daraja consumer secret>
DARAJA_PASSKEY=<Daraja STK passkey>
DARAJA_CALLBACK_URL=https://your-domain.example/api/integrations/daraja/callback
DARAJA_CALLBACK_SECRET=<unique random secret of at least 32 characters>
```

Generate a callback secret on the server with `openssl rand -hex 32`. Use `production` only with production Daraja credentials. After saving the file, restrict access with `chmod 600 .env.local`, rebuild the app, and restart its systemd service. Keep the callback secret private and stable so pending Daraja requests can still authenticate their callbacks. This environment configuration supports the STK prompt and its callback; use outlet-scoped database settings for multi-outlet deployments.

## 2. Apply migrations

SQL schema files live in `db/migrations/*.sql`, applied in filename order and tracked in a `schema_migrations` table so re-runs are safe:

```powershell
npm run db:migrate
```

### DigiTax catalog registration

Apply migrations before deploying code that adds or changes database-backed features. Migration `032_digitax_catalog_registration.sql` stores each catalog item's DigiTax profile, registration ID, and sync status.

In the app, enable DigiTax and save the sandbox API key in Property Settings. Add sale items in **Catalog** using an active, completed DigiTax profile: finished products require stock tracking, while services are non-stock items. KoreBench assigns the SKU as the barcode and registers the item with DigiTax. Check the per-item sync status; use **Sync KoreBench items to DigiTax** or the item's retry action if registration is pending or failed. The reverse **Import items from DigiTax** flow remains available for products already registered there and requires a barcode for safe matching.

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
