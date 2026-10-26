-- Kore Bench - Phase 8 Accounting

CREATE TABLE IF NOT EXISTS chart_of_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    code VARCHAR(20) NOT NULL,
    name VARCHAR(160) NOT NULL,
    account_type VARCHAR(20) NOT NULL CHECK (account_type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_property_account_code UNIQUE (property_id, code)
);

CREATE TABLE IF NOT EXISTS journal_entries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    entry_number VARCHAR(40) NOT NULL,
    entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
    description TEXT NOT NULL,
    source_type VARCHAR(30) NOT NULL CHECK (source_type IN ('pos_sale', 'folio_settlement', 'purchase_receipt', 'expense', 'manual', 'reversal')),
    source_id UUID,
    is_reversed BOOLEAN NOT NULL DEFAULT FALSE,
    reversed_entry_id UUID REFERENCES journal_entries(id) ON DELETE RESTRICT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_property_entry_number UNIQUE (property_id, entry_number)
);

CREATE TABLE IF NOT EXISTS journal_lines (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    journal_entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
    account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
    debit NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
    credit NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
    CONSTRAINT journal_line_one_side_only CHECK ((debit = 0 AND credit > 0) OR (credit = 0 AND debit > 0))
);

CREATE TABLE IF NOT EXISTS expenses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
    account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
    journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE RESTRICT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE chart_of_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY chart_of_accounts_tenant_isolation ON chart_of_accounts FOR ALL USING (property_id IN (SELECT get_current_user_property_ids()));
CREATE POLICY journal_entries_tenant_isolation ON journal_entries FOR ALL USING (property_id IN (SELECT get_current_user_property_ids()));
CREATE POLICY journal_lines_tenant_isolation ON journal_lines FOR ALL USING (property_id IN (SELECT get_current_user_property_ids()));
CREATE POLICY expenses_tenant_isolation ON expenses FOR ALL USING (property_id IN (SELECT get_current_user_property_ids()));

CREATE OR REPLACE FUNCTION assert_journal_entry_balanced(entry_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    total_debit NUMERIC(14, 2);
    total_credit NUMERIC(14, 2);
BEGIN
    SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
    INTO total_debit, total_credit
    FROM journal_lines
    WHERE journal_entry_id = entry_id;
    RETURN total_debit = total_credit AND total_debit > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
