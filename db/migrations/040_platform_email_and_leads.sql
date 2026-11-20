CREATE TABLE IF NOT EXISTS platform_email_config (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    smtp_host VARCHAR(253) NOT NULL,
    smtp_port INTEGER NOT NULL CHECK (smtp_port IN (465, 587)),
    smtp_username VARCHAR(320) NOT NULL,
    from_address VARCHAR(320) NOT NULL,
    notification_recipient VARCHAR(320) NOT NULL,
    password_encrypted TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

