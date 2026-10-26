ALTER TABLE items
    DROP CONSTRAINT IF EXISTS items_item_type_check,
    ADD CONSTRAINT items_item_type_check
        CHECK (item_type IN ('retail', 'menu', 'supply')),
    ADD CONSTRAINT items_supply_must_track_stock
        CHECK (item_type <> 'supply' OR stock_tracked = TRUE);

ALTER TABLE stock_levels
    DROP CONSTRAINT IF EXISTS stock_levels_warehouse_check,
    ADD CONSTRAINT stock_levels_warehouse_check
        CHECK (warehouse IN ('kitchen', 'bar', 'supplies'));

ALTER TABLE stock_requisitions
    DROP CONSTRAINT IF EXISTS stock_requisitions_destination_warehouse_check,
    ADD CONSTRAINT stock_requisitions_destination_warehouse_check
        CHECK (destination_warehouse IN ('kitchen', 'bar', 'supplies'));

ALTER TABLE stock_movements
    DROP CONSTRAINT IF EXISTS stock_movements_source_warehouse_check,
    DROP CONSTRAINT IF EXISTS stock_movements_destination_warehouse_check,
    DROP CONSTRAINT IF EXISTS stock_movement_location_shape,
    ADD CONSTRAINT stock_movements_source_warehouse_check
        CHECK (source_warehouse IS NULL OR source_warehouse IN ('central', 'kitchen', 'bar', 'supplies')),
    ADD CONSTRAINT stock_movements_destination_warehouse_check
        CHECK (destination_warehouse IS NULL OR destination_warehouse IN ('central', 'kitchen', 'bar', 'supplies')),
    ADD CONSTRAINT stock_movement_location_shape CHECK (
        (movement_type = 'purchase_receipt'
            AND source_outlet_id IS NULL AND source_warehouse IS NULL
            AND destination_outlet_id IS NULL AND destination_warehouse = 'central'
            AND supplier_name IS NOT NULL AND unit_cost IS NOT NULL)
        OR (movement_type = 'stock_transfer'
            AND source_outlet_id IS NULL AND source_warehouse = 'central'
            AND destination_outlet_id IS NOT NULL AND destination_warehouse IN ('kitchen', 'bar', 'supplies'))
        OR (movement_type = 'wastage'
            AND source_outlet_id IS NOT NULL AND source_warehouse IN ('kitchen', 'bar', 'supplies')
            AND destination_outlet_id IS NULL AND destination_warehouse IS NULL
            AND reason IS NOT NULL)
        OR (movement_type IN ('pos_sale', 'restaurant_sale')
            AND source_outlet_id IS NOT NULL AND source_warehouse IN ('kitchen', 'bar')
            AND destination_outlet_id IS NULL AND destination_warehouse IS NULL)
        OR (movement_type = 'opening_balance'
            AND source_outlet_id IS NULL AND source_warehouse IS NULL
            AND destination_outlet_id IS NOT NULL AND destination_warehouse IN ('kitchen', 'bar', 'supplies'))
    );
