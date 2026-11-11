CREATE TABLE IF NOT EXISTS purchases (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    supplier_name VARCHAR(255) NOT NULL CHECK (LENGTH(BTRIM(supplier_name)) > 0),
    purchase_date DATE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'ordered', 'received')),
    total NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (total >= 0),
    idempotency_key VARCHAR(160) NOT NULL,
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    ordered_by UUID REFERENCES users(id) ON DELETE RESTRICT,
    ordered_at TIMESTAMPTZ,
    received_by UUID REFERENCES users(id) ON DELETE RESTRICT,
    received_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_purchase_property_id UNIQUE (property_id, id),
    CONSTRAINT uq_purchase_property_idempotency UNIQUE (property_id, idempotency_key),
    CONSTRAINT purchase_status_timestamps CHECK (
        (status = 'draft' AND ordered_at IS NULL AND received_at IS NULL)
        OR (status = 'ordered' AND ordered_at IS NOT NULL AND received_at IS NULL)
        OR (status = 'received' AND ordered_at IS NOT NULL AND received_at IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS purchase_lines (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    purchase_id UUID NOT NULL,
    item_id UUID NOT NULL,
    item_name VARCHAR(255) NOT NULL,
    unit VARCHAR(40) NOT NULL,
    quantity NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
    unit_cost NUMERIC(12, 2) NOT NULL CHECK (unit_cost >= 0),
    line_total NUMERIC(12, 2) NOT NULL CHECK (line_total = ROUND(quantity * unit_cost, 2)),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_purchase_line_item UNIQUE (purchase_id, item_id),
    FOREIGN KEY (property_id, purchase_id) REFERENCES purchases(property_id, id) ON DELETE CASCADE,
    FOREIGN KEY (property_id, item_id) REFERENCES items(property_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_purchases_property_date
    ON purchases (property_id, purchase_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_purchases_property_status_date
    ON purchases (property_id, status, purchase_date DESC);

CREATE INDEX IF NOT EXISTS idx_purchase_lines_purchase
    ON purchase_lines (property_id, purchase_id);

ALTER TABLE purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY purchases_tenant_isolation ON purchases
    FOR ALL
    USING (property_id IN (SELECT get_current_user_property_ids()))
    WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));

CREATE POLICY purchase_lines_tenant_isolation ON purchase_lines
    FOR ALL
    USING (property_id IN (SELECT get_current_user_property_ids()))
    WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));
