-- ==============================================================================
-- Kore Bench - Phase 2 Restaurant & Bar Floor Plan
-- ==============================================================================

CREATE TABLE IF NOT EXISTS floor_areas (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    outlet_id UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
    name VARCHAR(120) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_outlet_floor_area_name UNIQUE (outlet_id, name)
);

CREATE TABLE IF NOT EXISTS tables (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    outlet_id UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
    floor_area_id UUID NOT NULL REFERENCES floor_areas(id) ON DELETE CASCADE,
    name VARCHAR(50) NOT NULL,
    capacity INTEGER NOT NULL CHECK (capacity > 0),
    status VARCHAR(20) NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'occupied', 'bill_requested', 'payment_pending', 'cleaning')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_outlet_table_name UNIQUE (outlet_id, name)
);

CREATE TABLE IF NOT EXISTS table_status_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    table_id UUID NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
    from_status VARCHAR(20),
    to_status VARCHAR(20) NOT NULL,
    changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Dine-in orders extend the existing orders table with a nullable table reference.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS table_id UUID REFERENCES tables(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS round_number INTEGER NOT NULL DEFAULT 1;

ALTER TABLE floor_areas ENABLE ROW LEVEL SECURITY;
ALTER TABLE tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE table_status_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY floor_areas_tenant_isolation ON floor_areas FOR ALL USING (property_id IN (SELECT get_current_user_property_ids()));
CREATE POLICY tables_tenant_isolation ON tables FOR ALL USING (property_id IN (SELECT get_current_user_property_ids()));
CREATE POLICY table_status_log_tenant_isolation ON table_status_log FOR ALL USING (property_id IN (SELECT get_current_user_property_ids()));
