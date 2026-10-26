ALTER TABLE items
  ADD COLUMN IF NOT EXISTS etims_item_code VARCHAR(80),
  ADD COLUMN IF NOT EXISTS etims_tax_code VARCHAR(10),
  ADD COLUMN IF NOT EXISTS etims_qty_unit_code VARCHAR(20),
  ADD COLUMN IF NOT EXISTS etims_pkg_unit_code VARCHAR(20),
  ADD COLUMN IF NOT EXISTS etims_item_class_code VARCHAR(40);

ALTER TABLE property_integration_configs
  ADD COLUMN IF NOT EXISTS etims_username VARCHAR(255),
  ADD COLUMN IF NOT EXISTS etims_password_encrypted TEXT;

ALTER TABLE etims_submissions
  ADD COLUMN IF NOT EXISTS restaurant_check_id UUID REFERENCES restaurant_checks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(100),
  ADD COLUMN IF NOT EXISTS scdc_id VARCHAR(160),
  ADD COLUMN IF NOT EXISTS invoice_signature TEXT,
  ADD COLUMN IF NOT EXISTS scu_receipt_date VARCHAR(80),
  ADD COLUMN IF NOT EXISTS scu_receipt_number VARCHAR(100),
  ADD COLUMN IF NOT EXISTS verification_url TEXT,
  ADD COLUMN IF NOT EXISTS error_message TEXT;

ALTER TABLE etims_submissions
  DROP CONSTRAINT IF EXISTS etims_submissions_status_check;

ALTER TABLE etims_submissions
  ADD CONSTRAINT etims_submissions_status_check
  CHECK (status IN ('pending', 'submitted', 'failed', 'blocked', 'unknown'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_etims_submission_restaurant_check
  ON etims_submissions (property_id, restaurant_check_id)
  WHERE restaurant_check_id IS NOT NULL;
