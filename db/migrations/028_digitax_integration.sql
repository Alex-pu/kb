ALTER TABLE etims_submissions
    ADD COLUMN IF NOT EXISTS provider VARCHAR(40) NOT NULL DEFAULT 'legacy';

CREATE TABLE IF NOT EXISTS digitax_configs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    outlet_id UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    api_base_url TEXT NOT NULL DEFAULT 'https://api.digitax.tech/ke/v2',
    api_key_encrypted TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_digitax_config_property_outlet UNIQUE (property_id, outlet_id)
);

ALTER TABLE digitax_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY digitax_configs_tenant_select ON digitax_configs
    FOR SELECT USING (property_id IN (SELECT get_current_user_property_ids()));

CREATE POLICY digitax_configs_tenant_insert ON digitax_configs
    FOR INSERT WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));

CREATE POLICY digitax_configs_tenant_update ON digitax_configs
    FOR UPDATE USING (property_id IN (SELECT get_current_user_property_ids()))
    WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));
