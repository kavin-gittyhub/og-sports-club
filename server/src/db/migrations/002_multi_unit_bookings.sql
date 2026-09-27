-- Multi-unit bookings: one booking can hold several nets/courts at once (e.g. "2 nets at 7:30").
-- Each held unit is a row in booking_units; the overlap guard moves from bookings to booking_units.

ALTER TABLE facility_groups
  ADD COLUMN unit_label text NOT NULL DEFAULT 'unit',            -- "net", "court" — shown as "How many nets?"
  ADD COLUMN max_units_per_booking int NOT NULL DEFAULT 0         -- 0 = up to all active units
    CHECK (max_units_per_booking >= 0);

UPDATE facility_groups SET unit_label = 'net'   WHERE slug = 'cricket-nets';
UPDATE facility_groups SET unit_label = 'court' WHERE slug = 'pickleball';
UPDATE facility_groups SET unit_label = 'turf'  WHERE slug IN ('og-turf', 'og-oval-turf');

ALTER TABLE bookings ADD COLUMN quantity int NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 50);

CREATE TABLE booking_units (
  id           bigserial PRIMARY KEY,
  booking_id   uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  resource_id  int NOT NULL REFERENCES resources(id),
  start_at     timestamptz NOT NULL,
  end_at       timestamptz NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  UNIQUE (booking_id, resource_id),
  CHECK (end_at > start_at),
  -- The double-booking guard: two live units can never overlap on the same net/court.
  CONSTRAINT booking_units_no_overlap EXCLUDE USING gist (
    resource_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (active)
);
CREATE INDEX booking_units_booking_idx ON booking_units (booking_id);
CREATE INDEX booking_units_resource_time_idx ON booking_units (resource_id, start_at);

INSERT INTO booking_units (booking_id, resource_id, start_at, end_at, active)
SELECT id, resource_id, start_at, end_at, status IN ('pending_payment', 'confirmed') FROM bookings;

ALTER TABLE bookings DROP CONSTRAINT bookings_no_overlap;

-- Keep units in step with their booking's times and status automatically
-- (cancel, expiry, confirmation, extension and admin moves all flow through here).
CREATE FUNCTION sync_booking_units() RETURNS trigger AS $$
BEGIN
  UPDATE booking_units
     SET start_at = NEW.start_at,
         end_at   = NEW.end_at,
         active   = NEW.status IN ('pending_payment', 'confirmed')
   WHERE booking_id = NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bookings_sync_units
  AFTER UPDATE OF status, start_at, end_at ON bookings
  FOR EACH ROW EXECUTE FUNCTION sync_booking_units();

-- Extensions of multi-unit bookings hold every unit; rows from one request share a batch id.
ALTER TABLE booking_extensions ADD COLUMN batch_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE INDEX booking_extensions_batch_idx ON booking_extensions (batch_id);
