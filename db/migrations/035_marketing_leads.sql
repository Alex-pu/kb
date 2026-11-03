CREATE TABLE IF NOT EXISTS marketing_leads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    full_name VARCHAR(160) NOT NULL,
    phone VARCHAR(30) NOT NULL,
    organization VARCHAR(180) NOT NULL,
    email VARCHAR(254) NOT NULL,
    plan VARCHAR(40) NOT NULL CHECK (plan IN ('hydra', 'virgo', 'ursa-major', 'not-sure')),
    preferred_demo_at TIMESTAMP NOT NULL,
    message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_marketing_leads_created_at
    ON marketing_leads (created_at DESC);
