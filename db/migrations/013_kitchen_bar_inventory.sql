ALTER TABLE items
    ADD COLUMN IF NOT EXISTS prep_station VARCHAR(20) NOT NULL DEFAULT 'kitchen'
        CHECK (prep_station IN ('kitchen', 'bar'));

UPDATE items i
SET prep_station = 'bar'
FROM categories c
WHERE c.id = i.category_id
  AND LOWER(BTRIM(c.name)) = 'beverage';

ALTER TABLE stock_levels
    ADD COLUMN IF NOT EXISTS warehouse VARCHAR(20) NOT NULL DEFAULT 'kitchen'
        CHECK (warehouse IN ('kitchen', 'bar'));

UPDATE stock_levels sl
SET warehouse = i.prep_station
FROM items i
WHERE sl.item_id = i.id;

ALTER TABLE stock_levels
    DROP CONSTRAINT IF EXISTS uq_outlet_item_stock;

ALTER TABLE stock_levels
    DROP CONSTRAINT IF EXISTS uq_outlet_item_warehouse_stock;

ALTER TABLE stock_levels
    ADD CONSTRAINT uq_outlet_item_warehouse_stock
        UNIQUE (outlet_id, item_id, warehouse);

INSERT INTO stock_levels (property_id, outlet_id, item_id, warehouse, quantity)
SELECT i.property_id, i.outlet_id, i.id, locations.warehouse, 0
FROM items i
CROSS JOIN (VALUES ('kitchen'::VARCHAR(20)), ('bar'::VARCHAR(20))) AS locations(warehouse)
WHERE i.stock_tracked
ON CONFLICT (outlet_id, item_id, warehouse) DO NOTHING;

UPDATE restaurant_kots
SET status = CASE
        WHEN status NOT IN ('served', 'cancelled') THEN 'cancelled'
        ELSE status
    END,
    cancel_reason = CASE
        WHEN status NOT IN ('served', 'cancelled')
            THEN COALESCE(cancel_reason, 'Bar orders do not require kitchen tickets.')
        ELSE cancel_reason
    END,
    archived_at = COALESCE(archived_at, NOW()),
    updated_at = NOW()
WHERE station = 'bar'
  AND archived_at IS NULL;
