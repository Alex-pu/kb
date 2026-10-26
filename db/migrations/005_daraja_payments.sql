-- ============================================================================
-- Daraja shop configuration and callback-backed payment queue
-- ============================================================================

CREATE TABLE IF NOT EXISTS daraja_shop_configs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    outlet_id UUID REFERENCES outlets(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    environment VARCHAR(20) NOT NULL DEFAULT 'sandbox' CHECK (environment IN ('sandbox', 'production')),
    short_code VARCHAR(40) NOT NULL,
    consumer_key_encrypted TEXT NOT NULL,
    consumer_secret_encrypted TEXT NOT NULL,
    passkey_encrypted TEXT NOT NULL,
    callback_url TEXT NOT NULL,
    timeout_url TEXT,
    callback_secret_encrypted TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_daraja_property_outlet UNIQUE (property_id, outlet_id)
);

CREATE TABLE IF NOT EXISTS daraja_payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    outlet_id UUID REFERENCES outlets(id) ON DELETE SET NULL,
    order_id VARCHAR(160),
    bill_reference VARCHAR(160),
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    transaction_code VARCHAR(80) NOT NULL,
    checkout_request_id VARCHAR(160),
    payer_phone VARCHAR(40),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'timeout')),
    callback_payload JSONB,
    idempotency_key VARCHAR(160) NOT NULL,
    applied_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_daraja_payment_idempotency UNIQUE (property_id, idempotency_key),
    CONSTRAINT uq_daraja_transaction_code UNIQUE (property_id, transaction_code),
    CONSTRAINT uq_daraja_checkout_request UNIQUE (property_id, checkout_request_id)
);

ALTER TABLE daraja_shop_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE daraja_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY daraja_configs_tenant_isolation ON daraja_shop_configs
    FOR SELECT USING (property_id IN (SELECT get_current_user_property_ids()));

CREATE POLICY daraja_configs_tenant_update ON daraja_shop_configs
    FOR UPDATE USING (property_id IN (SELECT get_current_user_property_ids()))
    WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));

CREATE POLICY daraja_configs_tenant_insert ON daraja_shop_configs
    FOR INSERT WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));

CREATE POLICY daraja_payments_tenant_isolation ON daraja_payments
    FOR SELECT USING (property_id IN (SELECT get_current_user_property_ids()));

CREATE POLICY daraja_payments_tenant_insert ON daraja_payments
    FOR INSERT WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));

CREATE POLICY daraja_payments_tenant_update ON daraja_payments
    FOR UPDATE USING (property_id IN (SELECT get_current_user_property_ids()))
    WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));

CREATE INDEX IF NOT EXISTS idx_daraja_payments_recent
    ON daraja_payments (property_id, status, created_at DESC);
