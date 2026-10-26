-- ==============================================================================
-- Kore Bench - Phase 1 Retail POS
-- ==============================================================================

CREATE TABLE IF NOT EXISTS categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    name VARCHAR(120) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_property_category_name UNIQUE (property_id, name)
);

CREATE TABLE IF NOT EXISTS items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    outlet_id UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL,
    sku VARCHAR(80) NOT NULL,
    barcode VARCHAR(80),
    item_type VARCHAR(30) NOT NULL DEFAULT 'retail' CHECK (item_type IN ('retail', 'menu')),
    price NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
    stock_tracked BOOLEAN NOT NULL DEFAULT TRUE,
    reorder_level NUMERIC(12, 3) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_property_item_sku UNIQUE (property_id, sku)
);

CREATE TABLE IF NOT EXISTS stock_levels (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    outlet_id UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
    item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    quantity NUMERIC(12, 3) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_outlet_item_stock UNIQUE (outlet_id, item_id)
);

CREATE TABLE IF NOT EXISTS shifts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    outlet_id UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
    station_id UUID NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
    cashier_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    opening_float NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (opening_float >= 0),
    cash_sales NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (cash_sales >= 0),
    status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    counted_cash NUMERIC(12, 2),
    variance NUMERIC(12, 2),
    CONSTRAINT closed_shift_requires_count CHECK (status = 'open' OR counted_cash IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    outlet_id UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
    station_id UUID NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
    shift_id UUID NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
    cashier_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    idempotency_key VARCHAR(160) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'posted' CHECK (status IN ('draft', 'posted', 'voided')),
    subtotal NUMERIC(12, 2) NOT NULL CHECK (subtotal >= 0),
    total NUMERIC(12, 2) NOT NULL CHECK (total >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_order_idempotency UNIQUE (property_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS order_lines (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    item_id UUID NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    quantity NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
    line_total NUMERIC(12, 2) NOT NULL CHECK (line_total >= 0)
);

CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    tender_type VARCHAR(20) NOT NULL CHECK (tender_type IN ('cash', 'mpesa', 'card')),
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    reference VARCHAR(160),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY categories_tenant_isolation ON categories FOR ALL USING (property_id IN (SELECT get_current_user_property_ids()));
CREATE POLICY items_tenant_isolation ON items FOR ALL USING (property_id IN (SELECT get_current_user_property_ids()));
CREATE POLICY stock_levels_tenant_isolation ON stock_levels FOR ALL USING (property_id IN (SELECT get_current_user_property_ids()));
CREATE POLICY shifts_tenant_isolation ON shifts FOR ALL USING (property_id IN (SELECT get_current_user_property_ids()));
CREATE POLICY orders_tenant_isolation ON orders FOR ALL USING (property_id IN (SELECT get_current_user_property_ids()));
CREATE POLICY order_lines_tenant_isolation ON order_lines FOR ALL USING (property_id IN (SELECT get_current_user_property_ids()));
CREATE POLICY payments_tenant_isolation ON payments FOR ALL USING (property_id IN (SELECT get_current_user_property_ids()));
