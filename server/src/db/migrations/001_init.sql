-- OG Sports Club — initial schema
-- All money values are stored as integer paise (₹1 = 100 paise).
-- All instants are timestamptz (UTC); the club's local time zone is applied in the app.
-- Minutes-of-day (0..1440) are local club time.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ─────────────────────────────────────────────────────────── users
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id   text UNIQUE,                 -- NULL for walk-in customers created by admin
  email           text,
  name            text,
  phone           text,
  role            text NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin')),
  is_blocked      boolean NOT NULL DEFAULT false,
  is_walk_in      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_email_idx ON users (lower(email));
CREATE INDEX users_phone_idx ON users (phone);

-- ─────────────────────────────────────────────────────────── facility groups (what customers see)
CREATE TABLE facility_groups (
  id                              serial PRIMARY KEY,
  slug                            text NOT NULL UNIQUE,
  name                            text NOT NULL,
  tagline                         text NOT NULL DEFAULT '',
  description                     text NOT NULL DEFAULT '',
  sport                           text NOT NULL DEFAULT 'football',   -- drives icon/illustration
  image_url                       text,
  features                        text[] NOT NULL DEFAULT '{}',
  open_minute                     int NOT NULL DEFAULT 360  CHECK (open_minute BETWEEN 0 AND 1435),
  close_minute                    int NOT NULL DEFAULT 1380 CHECK (close_minute BETWEEN 5 AND 1440),
  slot_interval_min               int NOT NULL DEFAULT 15   CHECK (slot_interval_min IN (5, 10, 15, 20, 30, 60)),
  min_duration_min                int NOT NULL DEFAULT 60   CHECK (min_duration_min >= 15 AND min_duration_min % 5 = 0),
  max_duration_min                int NOT NULL DEFAULT 180  CHECK (max_duration_min % 5 = 0),
  duration_step_min               int NOT NULL DEFAULT 30   CHECK (duration_step_min >= 5 AND duration_step_min % 5 = 0),
  advance_booking_days            int NOT NULL DEFAULT 30   CHECK (advance_booking_days BETWEEN 0 AND 365),
  min_lead_minutes                int NOT NULL DEFAULT 0    CHECK (min_lead_minutes >= 0),
  supports_bowling_machine        boolean NOT NULL DEFAULT false,
  bowling_machine_price_per_hour  int NOT NULL DEFAULT 0    CHECK (bowling_machine_price_per_hour >= 0),
  bowling_machine_units           int NOT NULL DEFAULT 1    CHECK (bowling_machine_units >= 0),
  is_active                       boolean NOT NULL DEFAULT true,
  sort_order                      int NOT NULL DEFAULT 0,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  CHECK (close_minute > open_minute),
  CHECK (max_duration_min >= min_duration_min)
);

-- ─────────────────────────────────────────────────────────── internal resources (never shown to customers)
CREATE TABLE resources (
  id                 serial PRIMARY KEY,
  facility_group_id  int NOT NULL REFERENCES facility_groups(id) ON DELETE CASCADE,
  name               text NOT NULL,             -- e.g. "Net A", "Court B"
  is_active          boolean NOT NULL DEFAULT true,
  sort_order         int NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_group_id, name)
);

-- ─────────────────────────────────────────────────────────── pricing rules
-- For every 5-minute slice of a booking the highest-priority matching rule sets the hourly rate.
CREATE TABLE pricing (
  id                 serial PRIMARY KEY,
  facility_group_id  int NOT NULL REFERENCES facility_groups(id) ON DELETE CASCADE,
  label              text NOT NULL DEFAULT 'Standard',
  days_of_week       int[],                     -- 0=Sun … 6=Sat; NULL = every day
  start_minute       int NOT NULL DEFAULT 0    CHECK (start_minute BETWEEN 0 AND 1435),
  end_minute         int NOT NULL DEFAULT 1440 CHECK (end_minute BETWEEN 5 AND 1440),
  price_per_hour     int NOT NULL CHECK (price_per_hour >= 0),
  priority           int NOT NULL DEFAULT 0,
  valid_from         date,
  valid_until        date,
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (end_minute > start_minute)
);
CREATE INDEX pricing_group_idx ON pricing (facility_group_id);

-- ─────────────────────────────────────────────────────────── bookings
CREATE TABLE bookings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_ref        text NOT NULL UNIQUE,
  user_id            uuid NOT NULL REFERENCES users(id),
  facility_group_id  int NOT NULL REFERENCES facility_groups(id),
  resource_id        int NOT NULL REFERENCES resources(id),
  start_at           timestamptz NOT NULL,
  end_at             timestamptz NOT NULL,
  bowling_machine    boolean NOT NULL DEFAULT false,
  base_amount        int NOT NULL DEFAULT 0,
  addon_amount       int NOT NULL DEFAULT 0,
  extension_amount   int NOT NULL DEFAULT 0,
  total_amount       int NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  refund_amount      int NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'pending_payment'
                     CHECK (status IN ('pending_payment', 'confirmed', 'cancelled', 'expired')),
  payment_status     text NOT NULL DEFAULT 'unpaid'
                     CHECK (payment_status IN ('unpaid', 'paid', 'pay_at_venue', 'refund_pending', 'refunded', 'partially_refunded')),
  source             text NOT NULL DEFAULT 'online' CHECK (source IN ('online', 'admin')),
  hold_expires_at    timestamptz,
  customer_name      text,
  customer_phone     text,
  notes              text,
  cancelled_at       timestamptz,
  cancelled_by       uuid REFERENCES users(id),
  cancel_reason      text,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  -- The ultimate double-booking guard: two live bookings can never overlap on the same resource.
  CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
    resource_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (status IN ('pending_payment', 'confirmed'))
);
CREATE INDEX bookings_group_time_idx ON bookings (facility_group_id, start_at);
CREATE INDEX bookings_user_idx ON bookings (user_id, start_at DESC);
CREATE INDEX bookings_status_idx ON bookings (status, hold_expires_at);

-- ─────────────────────────────────────────────────────────── booking extensions
CREATE TABLE booking_extensions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id         uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  resource_id        int NOT NULL REFERENCES resources(id),
  start_at           timestamptz NOT NULL,
  end_at             timestamptz NOT NULL,
  minutes            int NOT NULL CHECK (minutes > 0),
  amount             int NOT NULL CHECK (amount >= 0),
  status             text NOT NULL DEFAULT 'pending_payment'
                     CHECK (status IN ('pending_payment', 'confirmed', 'cancelled', 'expired')),
  hold_expires_at    timestamptz,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  CONSTRAINT extensions_no_overlap EXCLUDE USING gist (
    resource_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (status = 'pending_payment')
);
CREATE INDEX booking_extensions_booking_idx ON booking_extensions (booking_id);

-- ─────────────────────────────────────────────────────────── one-off blocks
CREATE TABLE blocked_slots (
  id                 serial PRIMARY KEY,
  facility_group_id  int NOT NULL REFERENCES facility_groups(id) ON DELETE CASCADE,
  resource_id        int REFERENCES resources(id) ON DELETE CASCADE,  -- NULL = whole facility
  start_at           timestamptz NOT NULL,
  end_at             timestamptz NOT NULL,
  reason             text NOT NULL DEFAULT '',
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at)
);
CREATE INDEX blocked_slots_group_time_idx ON blocked_slots (facility_group_id, start_at, end_at);

-- ─────────────────────────────────────────────────────────── recurring blocks
CREATE TABLE recurring_blocks (
  id                 serial PRIMARY KEY,
  facility_group_id  int NOT NULL REFERENCES facility_groups(id) ON DELETE CASCADE,
  resource_id        int REFERENCES resources(id) ON DELETE CASCADE,  -- NULL = whole facility
  days_of_week       int[] NOT NULL,            -- 0=Sun … 6=Sat
  start_minute       int NOT NULL CHECK (start_minute BETWEEN 0 AND 1435),
  end_minute         int NOT NULL CHECK (end_minute BETWEEN 5 AND 1440),
  valid_from         date NOT NULL DEFAULT CURRENT_DATE,
  valid_until        date,
  reason             text NOT NULL DEFAULT '',
  is_active          boolean NOT NULL DEFAULT true,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (end_minute > start_minute)
);
CREATE INDEX recurring_blocks_group_idx ON recurring_blocks (facility_group_id);

-- ─────────────────────────────────────────────────────────── payments
CREATE TABLE payments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id           uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  extension_id         uuid REFERENCES booking_extensions(id) ON DELETE SET NULL,
  user_id              uuid REFERENCES users(id),
  provider             text NOT NULL CHECK (provider IN ('razorpay', 'mock', 'cash', 'upi_offline', 'card_offline')),
  provider_order_id    text UNIQUE,
  provider_payment_id  text,
  amount               int NOT NULL CHECK (amount >= 0),
  currency             text NOT NULL DEFAULT 'INR',
  status               text NOT NULL DEFAULT 'created'
                       CHECK (status IN ('created', 'paid', 'failed', 'refund_pending', 'refunded', 'partially_refunded')),
  method               text,
  refund_amount        int NOT NULL DEFAULT 0,
  provider_refund_id   text,
  failure_reason       text,
  raw                  jsonb,
  paid_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_booking_idx ON payments (booking_id);
CREATE INDEX payments_created_idx ON payments (created_at DESC);
CREATE UNIQUE INDEX payments_provider_payment_idx ON payments (provider_payment_id) WHERE provider_payment_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────── audit trail
CREATE TABLE audit_logs (
  id              bigserial PRIMARY KEY,
  actor_user_id   uuid REFERENCES users(id),
  actor_role      text,
  action          text NOT NULL,
  entity_type     text,
  entity_id       text,
  details         jsonb NOT NULL DEFAULT '{}',
  ip              text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);

-- ─────────────────────────────────────────────────────────── club-wide settings & webhook idempotency
CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_events (
  id           text PRIMARY KEY,
  provider     text NOT NULL,
  event        text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);
