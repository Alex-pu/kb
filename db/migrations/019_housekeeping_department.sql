CREATE TABLE room_housekeeping_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    room_id UUID NOT NULL,
    assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_progress', 'completed')),
    checklist JSONB NOT NULL DEFAULT
        '{"cleanliness": false, "linens": false, "bathroom": false, "amenities": false, "maintenance": false}'::jsonb
        CHECK (
          jsonb_typeof(checklist) = 'object' AND
          checklist ?& ARRAY['cleanliness', 'linens', 'bathroom', 'amenities', 'maintenance'] AND
          checklist->>'cleanliness' IN ('true', 'false') AND
          checklist->>'linens' IN ('true', 'false') AND
          checklist->>'bathroom' IN ('true', 'false') AND
          checklist->>'amenities' IN ('true', 'false') AND
          checklist->>'maintenance' IN ('true', 'false')
        ),
    notes VARCHAR(1000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    CONSTRAINT fk_room_housekeeping_jobs_room_property
        FOREIGN KEY (room_id, property_id) REFERENCES rooms(id, property_id) ON DELETE CASCADE,
    CONSTRAINT chk_room_housekeeping_job_completion CHECK (
      (status = 'completed' AND completed_at IS NOT NULL) OR
      (status <> 'completed' AND completed_at IS NULL)
    )
);

CREATE UNIQUE INDEX uq_room_housekeeping_active_room
    ON room_housekeeping_jobs (room_id)
    WHERE status <> 'completed';
CREATE INDEX idx_room_housekeeping_property_status
    ON room_housekeeping_jobs (property_id, status, created_at);
CREATE INDEX idx_room_housekeeping_assignee
    ON room_housekeeping_jobs (assigned_to, status)
    WHERE assigned_to IS NOT NULL AND status <> 'completed';

INSERT INTO room_housekeeping_jobs (property_id, room_id, status)
SELECT r.property_id, r.id,
       CASE WHEN r.housekeeping_status = 'cleaning' THEN 'in_progress' ELSE 'pending' END
FROM rooms r
WHERE r.status IN ('available', 'reserved')
  AND r.housekeeping_status IN ('dirty', 'cleaning')
ON CONFLICT DO NOTHING;

ALTER TABLE room_housekeeping_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY room_housekeeping_jobs_tenant_isolation
    ON room_housekeeping_jobs FOR ALL
    USING (property_id IN (SELECT get_current_user_property_ids()))
    WITH CHECK (property_id IN (SELECT get_current_user_property_ids()));
