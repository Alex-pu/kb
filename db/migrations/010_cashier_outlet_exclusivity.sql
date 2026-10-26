CREATE TABLE cashier_outlet_sessions (
    outlet_id UUID PRIMARY KEY REFERENCES outlets(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX cashier_outlet_sessions_session_id_idx
    ON cashier_outlet_sessions (session_id);

CREATE INDEX cashier_outlet_sessions_user_id_idx
    ON cashier_outlet_sessions (user_id);

CREATE UNIQUE INDEX shifts_one_period_per_outlet_daily
    ON shifts (outlet_id, business_date, shift_area, shift_period)
    WHERE business_date IS NOT NULL AND shift_area IS NOT NULL AND shift_period IS NOT NULL;
