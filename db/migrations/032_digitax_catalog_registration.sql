ALTER TABLE items
    ADD COLUMN IF NOT EXISTS digitax_item_id VARCHAR(120),
    ADD COLUMN IF NOT EXISTS digitax_sync_status VARCHAR(20) NOT NULL DEFAULT 'not_synced',
    ADD COLUMN IF NOT EXISTS digitax_sync_error TEXT,
    ADD COLUMN IF NOT EXISTS digitax_item_type_code VARCHAR(10),
    ADD COLUMN IF NOT EXISTS etims_origin_nation_code VARCHAR(2),
    ADD COLUMN IF NOT EXISTS etims_qty_unit_code VARCHAR(20),
    ADD COLUMN IF NOT EXISTS etims_pkg_unit_code VARCHAR(20),
    ADD COLUMN IF NOT EXISTS digitax_levies TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE items
    DROP CONSTRAINT IF EXISTS items_digitax_sync_status_check,
    ADD CONSTRAINT items_digitax_sync_status_check
        CHECK (digitax_sync_status IN ('not_synced', 'sending', 'pending', 'synced', 'failed', 'not_configured'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_items_property_digitax_item
    ON items (property_id, digitax_item_id)
    WHERE digitax_item_id IS NOT NULL;
