CREATE TABLE housekeeping_checklist_items (
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    item_key VARCHAR(64) NOT NULL,
    label VARCHAR(160) NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (property_id, item_key),
    UNIQUE (property_id, sort_order),
    CONSTRAINT chk_housekeeping_checklist_item_key CHECK (item_key ~ '^[a-zA-Z0-9_-]{1,64}$'),
    CONSTRAINT chk_housekeeping_checklist_item_label CHECK (LENGTH(TRIM(label)) BETWEEN 1 AND 160)
);

ALTER TABLE housekeeping_checklist_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY housekeeping_checklist_items_tenant_isolation
    ON housekeeping_checklist_items FOR ALL
    USING (property_id IN (SELECT get_current_user_property_ids()))
    WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));

INSERT INTO housekeeping_checklist_items (property_id, item_key, label, sort_order)
SELECT p.id, item.item_key, item.label, item.sort_order
FROM properties p
CROSS JOIN (VALUES
    ('cleanliness', 'Room surfaces and floors are clean', 0),
    ('linens', 'Fresh, complete linens are fitted', 1),
    ('bathroom', 'Bathroom is clean and stocked', 2),
    ('amenities', 'Room amenities are present and working', 3),
    ('maintenance', 'No maintenance issues found', 4)
) AS item(item_key, label, sort_order)
ON CONFLICT (property_id, item_key) DO NOTHING;

CREATE FUNCTION seed_housekeeping_checklist_items()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO housekeeping_checklist_items (property_id, item_key, label, sort_order)
    VALUES
        (NEW.id, 'cleanliness', 'Room surfaces and floors are clean', 0),
        (NEW.id, 'linens', 'Fresh, complete linens are fitted', 1),
        (NEW.id, 'bathroom', 'Bathroom is clean and stocked', 2),
        (NEW.id, 'amenities', 'Room amenities are present and working', 3),
        (NEW.id, 'maintenance', 'No maintenance issues found', 4);
    RETURN NEW;
END;
$$;

CREATE TRIGGER properties_seed_housekeeping_checklist
    AFTER INSERT ON properties
    FOR EACH ROW EXECUTE FUNCTION seed_housekeeping_checklist_items();

ALTER TABLE room_housekeeping_jobs
    DROP CONSTRAINT room_housekeeping_jobs_checklist_check,
    ALTER COLUMN checklist SET DEFAULT '{}'::jsonb;

ALTER TABLE room_housekeeping_jobs
    ADD CONSTRAINT chk_room_housekeeping_checklist_object
    CHECK (jsonb_typeof(checklist) = 'object');

CREATE FUNCTION initialize_room_housekeeping_checklist()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    SELECT COALESCE(jsonb_object_agg(item_key, FALSE), '{}'::jsonb)
    INTO NEW.checklist
    FROM housekeeping_checklist_items
    WHERE property_id = NEW.property_id;
    RETURN NEW;
END;
$$;

CREATE TRIGGER room_housekeeping_jobs_initialize_checklist
    BEFORE INSERT ON room_housekeeping_jobs
    FOR EACH ROW EXECUTE FUNCTION initialize_room_housekeeping_checklist();

UPDATE room_housekeeping_jobs job
SET checklist = (
    SELECT COALESCE(
        jsonb_object_agg(item.item_key, COALESCE(job.checklist -> item.item_key, 'false'::jsonb)),
        '{}'::jsonb
    )
    FROM housekeeping_checklist_items item
    WHERE item.property_id = job.property_id
)
WHERE job.status <> 'completed';