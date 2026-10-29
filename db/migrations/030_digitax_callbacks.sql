ALTER TABLE etims_submissions
    ADD COLUMN IF NOT EXISTS callback_token_hash VARCHAR(64);
