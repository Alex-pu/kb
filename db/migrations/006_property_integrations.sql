-- ============================================================================
-- eTIMS and thermal printer configuration
-- ============================================================================

CREATE TABLE IF NOT EXISTS property_integration_configs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    outlet_id UUID REFERENCES outlets(id) ON DELETE CASCADE,
    etims_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    etims_business_name VARCHAR(255),
    etims_pin VARCHAR(50),
    etims_device_serial VARCHAR(120),
    etims_endpoint TEXT,
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

ALTER TABLE property_integration_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY property_integrations_tenant_select ON property_integration_configs
    FOR SELECT USING (property_id IN (SELECT get_current_user_property_ids()));

CREATE POLICY property_integrations_tenant_insert ON property_integration_configs
    FOR INSERT WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));

CREATE POLICY property_integrations_tenant_update ON property_integration_configs
    FOR UPDATE USING (property_id IN (SELECT get_current_user_property_ids()))
    WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));
