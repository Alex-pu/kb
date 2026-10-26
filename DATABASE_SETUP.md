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

## 2. Apply migrations

SQL schema files live in `db/migrations/*.sql`, applied in filename order and tracked in a `schema_migrations` table so re-runs are safe:

```powershell
npm run db:migrate
```

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
