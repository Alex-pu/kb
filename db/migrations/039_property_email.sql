CREATE TABLE property_email_configs (
    property_id UUID PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,
    smtp_host VARCHAR(253) NOT NULL,
    smtp_port INTEGER NOT NULL CHECK (smtp_port IN (465, 587)),
    smtp_username VARCHAR(320) NOT NULL,
    from_address VARCHAR(320) NOT NULL,
    password_encrypted TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE property_email_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY property_email_configs_tenant_select ON property_email_configs
    FOR SELECT USING (property_id IN (SELECT get_current_user_property_ids()));

CREATE POLICY property_email_configs_tenant_insert ON property_email_configs
    FOR INSERT WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));

CREATE POLICY property_email_configs_tenant_update ON property_email_configs
    FOR UPDATE USING (property_id IN (SELECT get_current_user_property_ids()))
    WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));

CREATE TABLE property_email_contacts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    full_name VARCHAR(160) NOT NULL CHECK (LENGTH(BTRIM(full_name)) > 0),
    email VARCHAR(320) NOT NULL CHECK (LENGTH(BTRIM(email)) > 0),
    group_name VARCHAR(120) NOT NULL DEFAULT 'General' CHECK (LENGTH(BTRIM(group_name)) > 0),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX property_email_contacts_property_email_unique
    ON property_email_contacts (property_id, LOWER(email));

CREATE INDEX property_email_contacts_property_group_idx
    ON property_email_contacts (property_id, LOWER(group_name), LOWER(full_name));

ALTER TABLE property_email_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY property_email_contacts_tenant_select ON property_email_contacts
    FOR SELECT USING (property_id IN (SELECT get_current_user_property_ids()));

CREATE POLICY property_email_contacts_tenant_insert ON property_email_contacts
    FOR INSERT WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));

CREATE POLICY property_email_contacts_tenant_update ON property_email_contacts
    FOR UPDATE USING (property_id IN (SELECT get_current_user_property_ids()))
    WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));

CREATE POLICY property_email_contacts_tenant_delete ON property_email_contacts
    FOR DELETE USING (property_id IN (SELECT get_current_user_property_ids()));
