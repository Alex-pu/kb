CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS properties (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(40) NOT NULL UNIQUE,
    property_type VARCHAR(40) NOT NULL DEFAULT 'hybrid',
    physical_address TEXT,
    phone_number VARCHAR(80),
    email VARCHAR(160),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS outlets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(40) NOT NULL,
    outlet_type VARCHAR(40) NOT NULL DEFAULT 'restaurant',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (property_id, code)
);

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
    CONSTRAINT uq_daraja_transaction_code UNIQUE (property_id, transaction_code)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_daraja_checkout_request
    ON daraja_payments (property_id, checkout_request_id)
    WHERE checkout_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_daraja_payments_recent
    ON daraja_payments (property_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_daraja_payments_unapplied_paid
    ON daraja_payments (property_id, status, applied_at, created_at DESC);

CREATE TABLE IF NOT EXISTS property_integration_configs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    outlet_id UUID REFERENCES outlets(id) ON DELETE CASCADE,
    printer_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    printer_model VARCHAR(160),
    printer_connection VARCHAR(30) CHECK (printer_connection IN ('network', 'bluetooth', 'usb')),
    printer_host VARCHAR(255),
    printer_port INTEGER CHECK (printer_port BETWEEN 1 AND 65535),
    auto_print_receipts BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_property_integration_outlet UNIQUE (property_id, outlet_id)
);

CREATE TABLE IF NOT EXISTS digitax_configs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    outlet_id UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    api_base_url TEXT NOT NULL DEFAULT 'https://api.digitax.tech/ke/v2',
    callback_url TEXT NOT NULL DEFAULT 'https://korebench.co.ke/api/integrations/digitax/callback',
    api_key_encrypted TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_digitax_config_property_outlet UNIQUE (property_id, outlet_id)
);

CREATE TABLE IF NOT EXISTS etims_submissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    outlet_id UUID REFERENCES outlets(id) ON DELETE SET NULL,
    provider VARCHAR(40) NOT NULL DEFAULT 'legacy',
    callback_token_hash VARCHAR(64),
    source_reference VARCHAR(160) NOT NULL,
    idempotency_key VARCHAR(160) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'failed')),
    provider_reference VARCHAR(160),
    provider_response JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_etims_submission_idempotency UNIQUE (property_id, provider, idempotency_key)
);
