ALTER TABLE digitax_configs
    ADD COLUMN IF NOT EXISTS callback_url TEXT NOT NULL
    DEFAULT 'https://korebench.co.ke/api/integrations/digitax/callback';
