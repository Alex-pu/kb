CREATE TABLE room_types (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    rate_per_night NUMERIC(12, 2) NOT NULL CHECK (rate_per_night >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_room_types_id_property UNIQUE (id, property_id)
);

CREATE UNIQUE INDEX uq_room_types_property_name_ci
    ON room_types (property_id, LOWER(name));

CREATE TABLE rooms (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    room_type_id UUID NOT NULL,
    room_number VARCHAR(30) NOT NULL,
    floor VARCHAR(40) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'available'
        CHECK (status IN ('available', 'occupied', 'reserved', 'maintenance')),
    housekeeping_status VARCHAR(20) NOT NULL DEFAULT 'dirty'
        CHECK (housekeeping_status IN ('dirty', 'cleaning', 'ready')),
    housekeeping_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    housekeeping_updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_rooms_id_property UNIQUE (id, property_id),
    CONSTRAINT fk_rooms_type_property FOREIGN KEY (room_type_id, property_id)
        REFERENCES room_types(id, property_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX uq_rooms_property_number_ci
    ON rooms (property_id, LOWER(room_number));
CREATE INDEX idx_rooms_property_type_status
    ON rooms (property_id, room_type_id, status, housekeeping_status);

CREATE TABLE room_bookings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    room_id UUID NOT NULL,
    guest_name VARCHAR(255) NOT NULL,
    guest_phone VARCHAR(50) NOT NULL,
    guest_id_number VARCHAR(100),
    guest_count INTEGER NOT NULL DEFAULT 1 CHECK (guest_count BETWEEN 1 AND 20),
    meal_add_ons JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(meal_add_ons) = 'object'),
    check_in_date DATE NOT NULL,
    check_out_date DATE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'reserved'
        CHECK (status IN ('reserved', 'checked_in', 'checked_out', 'cancelled')),
    actual_check_in TIMESTAMPTZ,
    actual_check_out TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_room_booking_dates CHECK (check_out_date > check_in_date),
    CONSTRAINT uq_room_bookings_id_property UNIQUE (id, property_id),
    CONSTRAINT fk_room_bookings_room_property FOREIGN KEY (room_id, property_id)
        REFERENCES rooms(id, property_id) ON DELETE RESTRICT
);

CREATE INDEX idx_room_bookings_property_status_dates
    ON room_bookings (property_id, status, check_in_date, check_out_date);
CREATE INDEX idx_room_bookings_room_status_dates
    ON room_bookings (room_id, status, check_in_date, check_out_date);

CREATE TABLE room_folios (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    booking_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_room_folios_booking UNIQUE (booking_id),
    CONSTRAINT uq_room_folios_id_property UNIQUE (id, property_id),
    CONSTRAINT fk_room_folios_booking_property FOREIGN KEY (booking_id, property_id)
        REFERENCES room_bookings(id, property_id) ON DELETE CASCADE
);

CREATE TABLE room_folio_lines (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    folio_id UUID NOT NULL,
    type VARCHAR(30) NOT NULL CHECK (type IN ('room_charge', 'service_charge', 'payment')),
    description VARCHAR(255) NOT NULL,
    amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
    reference VARCHAR(160),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_room_folio_lines_folio_property FOREIGN KEY (folio_id, property_id)
        REFERENCES room_folios(id, property_id) ON DELETE CASCADE
);

CREATE INDEX idx_room_folio_lines_folio_created
    ON room_folio_lines (folio_id, created_at, id);
CREATE UNIQUE INDEX uq_room_folio_lines_folio_reference
    ON room_folio_lines (folio_id, reference) WHERE reference IS NOT NULL;

ALTER TABLE room_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_folios ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_folio_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY room_types_tenant_isolation ON room_types FOR ALL
    USING (property_id IN (SELECT get_current_user_property_ids()))
    WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));
CREATE POLICY rooms_tenant_isolation ON rooms FOR ALL
    USING (property_id IN (SELECT get_current_user_property_ids()))
    WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));
CREATE POLICY room_bookings_tenant_isolation ON room_bookings FOR ALL
    USING (property_id IN (SELECT get_current_user_property_ids()))
    WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));
CREATE POLICY room_folios_tenant_isolation ON room_folios FOR ALL
    USING (property_id IN (SELECT get_current_user_property_ids()))
    WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));
CREATE POLICY room_folio_lines_tenant_isolation ON room_folio_lines FOR ALL
    USING (property_id IN (SELECT get_current_user_property_ids()))
    WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));
