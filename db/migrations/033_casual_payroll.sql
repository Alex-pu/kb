CREATE TABLE IF NOT EXISTS casual_payroll_employees (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    employee_code VARCHAR(100),
    full_name VARCHAR(200) NOT NULL,
    department VARCHAR(100) NOT NULL,
    phone VARCHAR(50),
    daily_rate NUMERIC(12, 2) NOT NULL CHECK (daily_rate > 0),
    status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    notes TEXT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (id, property_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_casual_payroll_employee_code
    ON casual_payroll_employees (property_id, employee_code)
    WHERE employee_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_casual_payroll_employees_property
    ON casual_payroll_employees (property_id, status, department, full_name);

CREATE TABLE IF NOT EXISTS casual_payroll_folio_counters (
    property_id UUID PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,
    next_number INTEGER NOT NULL DEFAULT 1 CHECK (next_number > 0)
);

CREATE TABLE IF NOT EXISTS casual_payroll_folios (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    folio_number INTEGER NOT NULL CHECK (folio_number > 0),
    week_start DATE NOT NULL,
    week_end DATE NOT NULL,
    prepared_by VARCHAR(200),
    checked_by VARCHAR(200),
    approved_by VARCHAR(200),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT casual_payroll_folio_week_length CHECK (week_end = week_start + 6),
    CONSTRAINT uq_casual_payroll_folio_number UNIQUE (property_id, folio_number),
    CONSTRAINT uq_casual_payroll_folio_week UNIQUE (property_id, week_start),
    UNIQUE (id, property_id)
);

CREATE TABLE IF NOT EXISTS casual_payroll_entries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    folio_id UUID NOT NULL,
    property_id UUID NOT NULL,
    employee_id UUID NOT NULL,
    employee_code VARCHAR(100),
    employee_name VARCHAR(200) NOT NULL,
    department VARCHAR(100) NOT NULL,
    phone VARCHAR(50),
    work_days DATE[] NOT NULL DEFAULT '{}',
    daily_rate NUMERIC(12, 2) NOT NULL CHECK (daily_rate > 0),
    deductions NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (deductions >= 0),
    amount_paid NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
    signature VARCHAR(200),
    notes TEXT,
    gross_pay NUMERIC(14, 2) GENERATED ALWAYS AS (cardinality(work_days) * daily_rate) STORED,
    net_pay NUMERIC(14, 2) GENERATED ALWAYS AS (cardinality(work_days) * daily_rate - deductions) STORED,
    balance_owed NUMERIC(14, 2) GENERATED ALWAYS AS (GREATEST(0, cardinality(work_days) * daily_rate - deductions - amount_paid)) STORED,
    payment_status VARCHAR(10) GENERATED ALWAYS AS (
        CASE
            WHEN GREATEST(0, cardinality(work_days) * daily_rate - deductions - amount_paid) = 0 THEN 'PAID'
            WHEN amount_paid > 0 THEN 'PART PAID'
            ELSE 'UNPAID'
        END
    ) STORED,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT casual_payroll_entry_days_count CHECK (cardinality(work_days) BETWEEN 0 AND 7),
    CONSTRAINT uq_casual_payroll_entry_employee UNIQUE (folio_id, employee_id),
    CONSTRAINT fk_casual_payroll_entry_folio FOREIGN KEY (folio_id, property_id)
        REFERENCES casual_payroll_folios(id, property_id) ON DELETE CASCADE,
    CONSTRAINT fk_casual_payroll_entry_employee FOREIGN KEY (employee_id, property_id)
        REFERENCES casual_payroll_employees(id, property_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_casual_payroll_folios_property_week
    ON casual_payroll_folios (property_id, week_start DESC);

CREATE INDEX IF NOT EXISTS idx_casual_payroll_entries_folio
    ON casual_payroll_entries (folio_id, department, employee_name);

ALTER TABLE casual_payroll_employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE casual_payroll_folio_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE casual_payroll_folios ENABLE ROW LEVEL SECURITY;
ALTER TABLE casual_payroll_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY casual_payroll_employees_tenant_isolation ON casual_payroll_employees
    FOR ALL
    USING (property_id IN (SELECT get_current_user_property_ids()))
    WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));

CREATE POLICY casual_payroll_folio_counters_tenant_isolation ON casual_payroll_folio_counters
    FOR ALL
    USING (property_id IN (SELECT get_current_user_property_ids()))
    WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));

CREATE POLICY casual_payroll_folios_tenant_isolation ON casual_payroll_folios
    FOR ALL
    USING (property_id IN (SELECT get_current_user_property_ids()))
    WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));

CREATE POLICY casual_payroll_entries_tenant_isolation ON casual_payroll_entries
    FOR ALL
    USING (property_id IN (SELECT get_current_user_property_ids()))
    WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));

UPDATE roles
SET permissions = permissions || '["payroll:manage"]'::jsonb
WHERE LOWER(role_key) IN ('admin', 'administrator', 'super_admin', 'general_manager', 'accountant')
  AND NOT (permissions ? 'payroll:manage');
