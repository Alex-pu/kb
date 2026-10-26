-- ==============================================================================
-- SME Hospitality & Retail Operations Platform
-- Phase 0: Multi-Tenant Core Schema & Row-Level Security (RLS)
-- Plain PostgreSQL (Neon) version — no Supabase Auth / PostgREST dependency.
-- ==============================================================================

-- 1. Enable UUID Extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Companies (Top-level SME Entity / Account)
CREATE TABLE IF NOT EXISTS companies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    tax_pin VARCHAR(50), -- e.g. KRA PIN
    country_code VARCHAR(2) DEFAULT 'KE',
    currency VARCHAR(3) DEFAULT 'KES',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Properties (A Hotel or Retail Location under a Company)
CREATE TABLE IF NOT EXISTS properties (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(50) NOT NULL, -- e.g. 'NAIROBI-CBD', 'THIKA-BRANCH'
    property_type VARCHAR(50) NOT NULL CHECK (property_type IN ('hotel', 'restaurant', 'retail', 'hybrid')),
    physical_address TEXT,
    phone_number VARCHAR(50),
    email VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_company_property_code UNIQUE (company_id, code)
);

-- 4. Outlets (A Restaurant, Bar, Front Desk, or Shop Counter within a Property)
CREATE TABLE IF NOT EXISTS outlets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(50) NOT NULL, -- e.g. 'BAR-01', 'RETAIL-MAIN', 'FRONT-DESK'
    outlet_type VARCHAR(50) NOT NULL CHECK (outlet_type IN ('retail_counter', 'restaurant', 'bar', 'front_desk', 'kitchen', 'store')),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_property_outlet_code UNIQUE (property_id, code)
);

-- 5. Stations (A physical POS till, Kitchen Prep Station, or Reception terminal)
CREATE TABLE IF NOT EXISTS stations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    outlet_id UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    station_type VARCHAR(50) NOT NULL CHECK (station_type IN ('pos_till', 'kds_screen', 'reception_terminal', 'store_terminal')),
    hardware_identifier VARCHAR(255), -- MAC address / Terminal Device ID
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. System Roles (Role definitions with permission matrix)
CREATE TABLE IF NOT EXISTS roles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID REFERENCES companies(id) ON DELETE CASCADE, -- NULL means system-wide default role
    name VARCHAR(100) NOT NULL,
    role_key VARCHAR(50) NOT NULL, -- e.g. 'super_admin', 'director', 'general_manager', 'cashier', 'waiter', 'receptionist', 'chef'
    description TEXT,
    permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_system_role BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. User Profiles (own credentials — no Supabase Auth)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    full_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE,
    phone_number VARCHAR(50) UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. User Assignments (User x Property x Outlet x Station x Role x Limits)
CREATE TABLE IF NOT EXISTS user_assignments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    outlet_id UUID REFERENCES outlets(id) ON DELETE SET NULL,
    station_id UUID REFERENCES stations(id) ON DELETE SET NULL,
    role_id UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
    max_discount_percent NUMERIC(5, 2) DEFAULT 0.00,
    max_void_amount NUMERIC(12, 2) DEFAULT 0.00,
    can_override_approval BOOLEAN DEFAULT FALSE,
    effective_from TIMESTAMPTZ DEFAULT NOW(),
    effective_to TIMESTAMPTZ,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_user_property_outlet_role UNIQUE (user_id, property_id, outlet_id, role_id)
);

-- 9. Immutable Audit Log (Append-only)
CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    property_id UUID REFERENCES properties(id) ON DELETE SET NULL,
    outlet_id UUID REFERENCES outlets(id) ON DELETE SET NULL,
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action_type VARCHAR(100) NOT NULL, -- e.g. 'AUTH.LOGIN', 'SHIFT.OPEN', 'ORDER.CREATE'
    resource_type VARCHAR(100) NOT NULL, -- e.g. 'orders', 'shifts', 'folios'
    resource_id UUID,
    payload_before JSONB,
    payload_after JSONB,
    ip_address VARCHAR(50),
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 10. Server-side sessions (signed cookie token -> row, so logins can be revoked)
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL UNIQUE,
    ip_address VARCHAR(50),
    user_agent TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==============================================================================
-- Row-Level Security (RLS) Policies
-- Tenant isolation is enforced in the database, not only in application-level IF
-- checks. Because there is no Supabase Auth/PostgREST layer, the Next.js server
-- sets a per-request Postgres session variable (app.current_user_id) right after
-- authenticating a request, and these policies key off that instead of auth.uid().
-- ==============================================================================

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE outlets ENABLE ROW LEVEL SECURITY;
ALTER TABLE stations ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Helper function: get current active user's assigned property IDs, based on the
-- app.current_user_id session variable set by the application after login.
CREATE OR REPLACE FUNCTION get_current_user_property_ids()
RETURNS TABLE (property_id UUID) AS $$
BEGIN
    RETURN QUERY
    SELECT ua.property_id
    FROM user_assignments ua
    JOIN users u ON u.id = ua.user_id
    WHERE u.id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      AND ua.is_active = TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- RLS: Properties
CREATE POLICY properties_tenant_isolation ON properties
    FOR ALL
    USING (
        id IN (SELECT get_current_user_property_ids())
    );

-- RLS: Outlets
CREATE POLICY outlets_tenant_isolation ON outlets
    FOR ALL
    USING (
        property_id IN (SELECT get_current_user_property_ids())
    );

-- RLS: Stations
CREATE POLICY stations_tenant_isolation ON stations
    FOR ALL
    USING (
        outlet_id IN (
            SELECT o.id FROM outlets o WHERE o.property_id IN (SELECT get_current_user_property_ids())
        )
    );

-- No demo/placeholder data is seeded here. Run `npm run db:bootstrap` after the
-- migrations to create your real company, property, outlet, roles and admin user.
