ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_single_platform_super_admin
    ON users (is_super_admin)
    WHERE is_super_admin = TRUE;

INSERT INTO companies (id, name, country_code, currency)
VALUES ('00000000-0000-4000-8000-000000000001', 'Kore Bench Platform', 'KE', 'KES')
ON CONFLICT (id) DO NOTHING;
