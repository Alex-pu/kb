-- ============================================================================
-- eTIMS submission ledger for idempotent fiscalization attempts
-- ============================================================================

CREATE TABLE IF NOT EXISTS etims_submissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    outlet_id UUID REFERENCES outlets(id) ON DELETE SET NULL,
    source_reference VARCHAR(160) NOT NULL,
    idempotency_key VARCHAR(160) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'failed')),
    provider_reference VARCHAR(160),
    provider_response JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_etims_submission_idempotency UNIQUE (property_id, idempotency_key)
);

ALTER TABLE etims_submissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY etims_submissions_tenant_select ON etims_submissions
    FOR SELECT USING (property_id IN (SELECT get_current_user_property_ids()));

CREATE POLICY etims_submissions_tenant_insert ON etims_submissions
    FOR INSERT WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));

CREATE POLICY etims_submissions_tenant_update ON etims_submissions
    FOR UPDATE USING (property_id IN (SELECT get_current_user_property_ids()))
    WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));
