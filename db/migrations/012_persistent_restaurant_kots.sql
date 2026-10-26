CREATE TABLE IF NOT EXISTS restaurant_kots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    outlet_id UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
    check_id UUID NOT NULL REFERENCES restaurant_checks(id) ON DELETE CASCADE,
    table_ref VARCHAR(100) NOT NULL,
    table_name VARCHAR(100) NOT NULL,
    round INTEGER NOT NULL CHECK (round > 0),
    station VARCHAR(20) NOT NULL CHECK (station IN ('kitchen', 'bar')),
    status VARCHAR(20) NOT NULL DEFAULT 'new'
        CHECK (status IN ('new', 'accepted', 'preparing', 'ready', 'served', 'cancelled')),
    lines JSONB NOT NULL CHECK (jsonb_typeof(lines) = 'array'),
    cancel_reason VARCHAR(500),
    archived_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_restaurant_kot_check_round_station UNIQUE (check_id, round, station)
);

CREATE INDEX IF NOT EXISTS idx_restaurant_kots_active_outlet
    ON restaurant_kots (outlet_id, created_at)
    WHERE archived_at IS NULL AND status NOT IN ('served', 'cancelled');

CREATE INDEX IF NOT EXISTS idx_restaurant_kots_check
    ON restaurant_kots (check_id);

ALTER TABLE restaurant_kots ENABLE ROW LEVEL SECURITY;

CREATE POLICY restaurant_kots_tenant_isolation ON restaurant_kots
    FOR ALL USING (property_id IN (SELECT get_current_user_property_ids()));
