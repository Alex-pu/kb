ALTER TABLE items
    ADD COLUMN IF NOT EXISTS unit VARCHAR(40) NOT NULL DEFAULT 'each'
        CHECK (LENGTH(BTRIM(unit)) > 0);

CREATE UNIQUE INDEX IF NOT EXISTS uq_items_property_id_id
    ON items (property_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_outlets_property_id_id
    ON outlets (property_id, id);

CREATE TABLE IF NOT EXISTS item_outlets (
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    outlet_id UUID NOT NULL,
    item_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (outlet_id, item_id),
    FOREIGN KEY (property_id, outlet_id) REFERENCES outlets(property_id, id) ON DELETE CASCADE,
    FOREIGN KEY (property_id, item_id) REFERENCES items(property_id, id) ON DELETE CASCADE
);

INSERT INTO item_outlets (property_id, outlet_id, item_id)
SELECT property_id, outlet_id, id
FROM items
ON CONFLICT (outlet_id, item_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_item_outlets_property_outlet
    ON item_outlets (property_id, outlet_id);

ALTER TABLE item_outlets ENABLE ROW LEVEL SECURITY;

CREATE POLICY item_outlets_tenant_isolation ON item_outlets
    FOR ALL USING (property_id IN (SELECT get_current_user_property_ids()));

CREATE TABLE IF NOT EXISTS central_stock_levels (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    item_id UUID NOT NULL,
    quantity NUMERIC(12, 3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_property_central_item_stock UNIQUE (property_id, item_id),
    FOREIGN KEY (property_id, item_id) REFERENCES items(property_id, id) ON DELETE CASCADE
);

INSERT INTO central_stock_levels (property_id, item_id, quantity)
SELECT property_id, id, 0
FROM items
ON CONFLICT (property_id, item_id) DO NOTHING;

ALTER TABLE central_stock_levels ENABLE ROW LEVEL SECURITY;

CREATE POLICY central_stock_levels_tenant_isolation ON central_stock_levels
    FOR ALL USING (property_id IN (SELECT get_current_user_property_ids()));

CREATE TABLE IF NOT EXISTS stock_requisitions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    outlet_id UUID NOT NULL,
    destination_warehouse VARCHAR(20) NOT NULL CHECK (destination_warehouse IN ('kitchen', 'bar')),
    requester_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    resolved_by UUID REFERENCES users(id) ON DELETE RESTRICT,
    status VARCHAR(24) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'partially_fulfilled', 'fulfilled', 'rejected', 'cancelled')),
    note VARCHAR(500),
    rejection_reason VARCHAR(500),
    idempotency_key VARCHAR(160) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    CONSTRAINT uq_stock_requisition_idempotency UNIQUE (property_id, idempotency_key),
    CONSTRAINT uq_stock_requisition_property_id UNIQUE (property_id, id),
    FOREIGN KEY (property_id, outlet_id) REFERENCES outlets(property_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS stock_requisition_lines (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    requisition_id UUID NOT NULL,
    item_id UUID NOT NULL,
    quantity_requested NUMERIC(12, 3) NOT NULL CHECK (quantity_requested > 0),
    quantity_fulfilled NUMERIC(12, 3) NOT NULL DEFAULT 0
        CHECK (quantity_fulfilled >= 0 AND quantity_fulfilled <= quantity_requested),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_stock_requisition_item UNIQUE (requisition_id, item_id),
    FOREIGN KEY (property_id, requisition_id) REFERENCES stock_requisitions(property_id, id) ON DELETE CASCADE,
    FOREIGN KEY (property_id, item_id) REFERENCES items(property_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_stock_requisitions_property_status
    ON stock_requisitions (property_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_requisitions_outlet
    ON stock_requisitions (outlet_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_requisition_lines_request
    ON stock_requisition_lines (requisition_id);

ALTER TABLE stock_requisitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_requisition_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY stock_requisitions_tenant_isolation ON stock_requisitions
    FOR ALL USING (property_id IN (SELECT get_current_user_property_ids()));

CREATE POLICY stock_requisition_lines_tenant_isolation ON stock_requisition_lines
    FOR ALL USING (property_id IN (SELECT get_current_user_property_ids()));

CREATE TABLE IF NOT EXISTS stock_movements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    item_id UUID NOT NULL,
    movement_type VARCHAR(30) NOT NULL
        CHECK (movement_type IN ('purchase_receipt', 'stock_transfer', 'wastage', 'pos_sale', 'restaurant_sale', 'opening_balance')),
    quantity NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
    source_outlet_id UUID,
    source_warehouse VARCHAR(20)
        CHECK (source_warehouse IS NULL OR source_warehouse IN ('central', 'kitchen', 'bar')),
    destination_outlet_id UUID,
    destination_warehouse VARCHAR(20)
        CHECK (destination_warehouse IS NULL OR destination_warehouse IN ('central', 'kitchen', 'bar')),
    unit_cost NUMERIC(12, 2) CHECK (unit_cost IS NULL OR unit_cost >= 0),
    supplier_name VARCHAR(255),
    reason VARCHAR(500),
    reference_type VARCHAR(40),
    reference_id UUID,
    requisition_id UUID,
    idempotency_key VARCHAR(160) NOT NULL,
    actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_stock_movement_idempotency UNIQUE (property_id, idempotency_key),
    FOREIGN KEY (property_id, item_id) REFERENCES items(property_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (property_id, source_outlet_id) REFERENCES outlets(property_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (property_id, destination_outlet_id) REFERENCES outlets(property_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (property_id, requisition_id) REFERENCES stock_requisitions(property_id, id) ON DELETE RESTRICT,
    CONSTRAINT stock_movement_location_shape CHECK (
        (movement_type = 'purchase_receipt'
            AND source_outlet_id IS NULL AND source_warehouse IS NULL
            AND destination_outlet_id IS NULL AND destination_warehouse = 'central'
            AND supplier_name IS NOT NULL AND unit_cost IS NOT NULL)
        OR (movement_type = 'stock_transfer'
            AND source_outlet_id IS NULL AND source_warehouse = 'central'
            AND destination_outlet_id IS NOT NULL AND destination_warehouse IN ('kitchen', 'bar'))
        OR (movement_type = 'wastage'
            AND source_outlet_id IS NOT NULL AND source_warehouse IN ('kitchen', 'bar')
            AND destination_outlet_id IS NULL AND destination_warehouse IS NULL
            AND reason IS NOT NULL)
        OR (movement_type IN ('pos_sale', 'restaurant_sale')
            AND source_outlet_id IS NOT NULL AND source_warehouse IN ('kitchen', 'bar')
            AND destination_outlet_id IS NULL AND destination_warehouse IS NULL)
        OR (movement_type = 'opening_balance'
            AND source_outlet_id IS NULL AND source_warehouse IS NULL
            AND destination_outlet_id IS NOT NULL AND destination_warehouse IN ('kitchen', 'bar'))
    )
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_property_created
    ON stock_movements (property_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_movements_outlet_created
    ON stock_movements (destination_outlet_id, source_outlet_id, created_at DESC);

ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;

CREATE POLICY stock_movements_tenant_read ON stock_movements
    FOR SELECT USING (property_id IN (SELECT get_current_user_property_ids()));

CREATE POLICY stock_movements_tenant_insert ON stock_movements
    FOR INSERT WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));
