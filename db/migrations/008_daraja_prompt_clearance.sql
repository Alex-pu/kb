-- Track STK Push prompt IDs and whether a paid callback has been applied to a bill.

ALTER TABLE daraja_payments
    ADD COLUMN IF NOT EXISTS checkout_request_id VARCHAR(160),
    ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_daraja_checkout_request
    ON daraja_payments (property_id, checkout_request_id)
    WHERE checkout_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_daraja_payments_unapplied_paid
    ON daraja_payments (property_id, status, applied_at, created_at DESC);
