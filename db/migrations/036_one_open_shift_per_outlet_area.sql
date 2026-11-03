DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM shifts
        WHERE status = 'open'
        GROUP BY outlet_id, COALESCE(shift_area, 'pos')
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION
            'Cannot enforce one open shift per outlet and work area: close existing duplicate shifts, then rerun migrations.';
    END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS shifts_one_open_area_per_outlet
    ON shifts (outlet_id, COALESCE(shift_area, 'pos'))
    WHERE status = 'open';
