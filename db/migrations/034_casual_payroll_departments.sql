CREATE TABLE IF NOT EXISTS casual_payroll_departments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO casual_payroll_departments (company_id, property_id, name)
SELECT company_id, property_id, MIN(BTRIM(department))
FROM casual_payroll_employees
WHERE BTRIM(department) <> ''
GROUP BY company_id, property_id, LOWER(BTRIM(department))
ON CONFLICT DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS uq_casual_payroll_department_name
    ON casual_payroll_departments (property_id, LOWER(name));

CREATE INDEX IF NOT EXISTS idx_casual_payroll_departments_property
    ON casual_payroll_departments (property_id, name);

ALTER TABLE casual_payroll_departments ENABLE ROW LEVEL SECURITY;

CREATE POLICY casual_payroll_departments_tenant_isolation ON casual_payroll_departments
    FOR ALL
    USING (property_id IN (SELECT get_current_user_property_ids()))
    WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));
