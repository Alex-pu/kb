CREATE TABLE restaurant_room_charge_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    outlet_id UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
    check_id UUID NOT NULL REFERENCES restaurant_checks(id) ON DELETE RESTRICT,
    booking_id UUID NOT NULL REFERENCES room_bookings(id) ON DELETE RESTRICT,
    folio_id UUID NOT NULL REFERENCES room_folios(id) ON DELETE RESTRICT,
    table_ref VARCHAR(100) NOT NULL,
    table_name VARCHAR(100) NOT NULL,
    guest_name VARCHAR(255) NOT NULL,
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    requested_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),
    reason VARCHAR(255),
    resolved_by UUID REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    CONSTRAINT chk_restaurant_room_charge_resolution CHECK (
      (status = 'pending' AND resolved_by IS NULL AND resolved_at IS NULL) OR
      (status <> 'pending' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX uq_restaurant_room_charge_pending_check
    ON restaurant_room_charge_requests (check_id)
    WHERE status = 'pending';
CREATE INDEX idx_restaurant_room_charge_property_pending
    ON restaurant_room_charge_requests (property_id, created_at)
    WHERE status = 'pending';

ALTER TABLE restaurant_room_charge_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY restaurant_room_charge_requests_tenant_isolation
    ON restaurant_room_charge_requests FOR ALL
    USING (property_id IN (SELECT get_current_user_property_ids()))
    WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));

ALTER TABLE restaurant_check_payments
    DROP CONSTRAINT restaurant_check_payments_tender_type_check;
ALTER TABLE restaurant_check_payments
    ADD CONSTRAINT restaurant_check_payments_tender_type_check
    CHECK (tender_type IN ('cash', 'mpesa', 'card', 'room_charge'));
