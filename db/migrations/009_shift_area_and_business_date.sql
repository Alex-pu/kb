ALTER TABLE shifts
    ADD COLUMN IF NOT EXISTS shift_area VARCHAR(20),
    ADD COLUMN IF NOT EXISTS shift_period VARCHAR(20),
    ADD COLUMN IF NOT EXISTS business_date DATE;

ALTER TABLE shifts
    ADD CONSTRAINT shifts_area_valid
        CHECK (shift_area IS NULL OR shift_area IN ('pos', 'reservation')),
    ADD CONSTRAINT shifts_period_valid
        CHECK (shift_period IS NULL OR shift_period IN ('morning', 'evening')),
    ADD CONSTRAINT shifts_area_period_date_all_or_none
        CHECK (
            (shift_area IS NULL AND shift_period IS NULL AND business_date IS NULL)
            OR (shift_area IS NOT NULL AND shift_period IS NOT NULL AND business_date IS NOT NULL)
        );

CREATE UNIQUE INDEX shifts_one_period_per_area_daily
    ON shifts (station_id, business_date, shift_area, shift_period)
    WHERE business_date IS NOT NULL AND shift_area IS NOT NULL AND shift_period IS NOT NULL;
