ALTER TABLE property_integration_configs
    DROP COLUMN IF EXISTS etims_enabled,
    DROP COLUMN IF EXISTS etims_business_name,
    DROP COLUMN IF EXISTS etims_pin,
    DROP COLUMN IF EXISTS etims_device_serial,
    DROP COLUMN IF EXISTS etims_endpoint,
    DROP COLUMN IF EXISTS etims_username,
    DROP COLUMN IF EXISTS etims_password_encrypted;

ALTER TABLE items
    DROP COLUMN IF EXISTS etims_qty_unit_code,
    DROP COLUMN IF EXISTS etims_pkg_unit_code;

ALTER TABLE etims_submissions
    DROP CONSTRAINT IF EXISTS uq_etims_submission_idempotency;

CREATE UNIQUE INDEX IF NOT EXISTS uq_etims_submission_provider_idempotency
    ON etims_submissions (property_id, provider, idempotency_key);

DROP INDEX IF EXISTS uq_etims_submission_restaurant_check;

CREATE UNIQUE INDEX IF NOT EXISTS uq_etims_submission_provider_restaurant_check
    ON etims_submissions (property_id, provider, restaurant_check_id)
    WHERE restaurant_check_id IS NOT NULL;
