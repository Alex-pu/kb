ALTER TABLE users
  ADD COLUMN IF NOT EXISTS pin_hash VARCHAR(255);

CREATE TABLE IF NOT EXISTS auth_pin_login_attempts (
  identifier_hash CHAR(64) PRIMARY KEY,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
