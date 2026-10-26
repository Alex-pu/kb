CREATE TABLE IF NOT EXISTS catalog_sku_counters (
    property_id UUID PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,
    next_value BIGINT NOT NULL DEFAULT 1 CHECK (next_value > 0)
);

ALTER TABLE catalog_sku_counters ENABLE ROW LEVEL SECURITY;

CREATE POLICY catalog_sku_counters_tenant_isolation ON catalog_sku_counters
    FOR ALL USING (property_id IN (SELECT get_current_user_property_ids()));
