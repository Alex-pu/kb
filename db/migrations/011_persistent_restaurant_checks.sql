CREATE TABLE IF NOT EXISTS restaurant_checks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    outlet_id UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
    table_ref VARCHAR(100) NOT NULL,
    table_name VARCHAR(100) NOT NULL,
    shift_id UUID NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
    cashier_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    waiter_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    lines JSONB NOT NULL CHECK (jsonb_typeof(lines) = 'array'),
    total NUMERIC(12, 2) NOT NULL CHECK (total >= 0),
    status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'voided')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    settled_at TIMESTAMPTZ,
    CONSTRAINT restaurant_check_settlement_state CHECK (
      (status = 'settled' AND settled_at IS NOT NULL) OR
      (status <> 'settled' AND settled_at IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_restaurant_check_open_table
    ON restaurant_checks (outlet_id, table_ref)
    WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_restaurant_checks_open_shift
    ON restaurant_checks (shift_id, waiter_id)
    WHERE status = 'open';

CREATE TABLE IF NOT EXISTS restaurant_check_payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    check_id UUID NOT NULL REFERENCES restaurant_checks(id) ON DELETE RESTRICT,
    tender_type VARCHAR(20) NOT NULL CHECK (tender_type IN ('cash', 'mpesa', 'card')),
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    reference VARCHAR(160),
    idempotency_key VARCHAR(160) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_restaurant_check_payment_idempotency UNIQUE (check_id, idempotency_key, tender_type)
);

CREATE INDEX IF NOT EXISTS idx_restaurant_check_payments_property
    ON restaurant_check_payments (property_id, created_at DESC);

ALTER TABLE restaurant_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurant_check_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY restaurant_checks_tenant_isolation ON restaurant_checks
    FOR ALL USING (property_id IN (SELECT get_current_user_property_ids()));

CREATE POLICY restaurant_check_payments_tenant_isolation ON restaurant_check_payments
    FOR ALL USING (property_id IN (SELECT get_current_user_property_ids()));
