import { config } from '../config.js';
import { zonedDateTimeToUtc, todayInZone, addDays } from '../lib/time.js';

const rupees = (r) => r * 100;
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];

// The club's real structure. Prices/hours are sensible defaults the owner edits in Admin → Facilities / Pricing.
const FACILITIES = [
  {
    slug: 'og-turf', name: 'OG Turf', sport: 'football', sort: 1,
    tagline: 'Floodlit 5/7-a-side football turf',
    description: 'Premium FIFA-grade artificial grass with LED floodlights. Perfect for 5-a-side and 7-a-side football.',
    features: ['Floodlights', 'Changing rooms', 'Drinking water', 'Parking'],
    open: 360, close: 1440, interval: 15, min: 60, max: 180, step: 30,
    resources: ['Turf'], unitLabel: 'turf',
    prices: [
      { label: 'Day', days: WEEKDAYS, start: 0, end: 1020, price: 600, priority: 0 },
      { label: 'Evening peak', days: WEEKDAYS, start: 1020, end: 1440, price: 800, priority: 10 },
      { label: 'Weekend', days: WEEKEND, start: 0, end: 1440, price: 1000, priority: 20 },
    ],
  },
  {
    slug: 'og-oval-turf', name: 'OG Oval Turf', sport: 'oval', sort: 2,
    tagline: 'Full-size oval for box cricket & football',
    description: 'Our large oval turf — ideal for box cricket matches, team practice and bigger football games.',
    features: ['Floodlights', 'Scoreboard', 'Seating', 'Parking'],
    open: 360, close: 1440, interval: 15, min: 60, max: 240, step: 30,
    resources: ['Oval'], unitLabel: 'turf',
    prices: [
      { label: 'Day', days: WEEKDAYS, start: 0, end: 1020, price: 1200, priority: 0 },
      { label: 'Evening peak', days: WEEKDAYS, start: 1020, end: 1440, price: 1500, priority: 10 },
      { label: 'Weekend', days: WEEKEND, start: 0, end: 1440, price: 1800, priority: 20 },
    ],
  },
  {
    slug: 'cricket-nets', name: 'Cricket Nets', sport: 'cricket', sort: 3,
    tagline: 'Practice nets with optional bowling machine',
    description: 'Professional practice nets with quality matting. Add our bowling machine for focused batting practice.',
    features: ['Bowling machine available', 'Floodlights', 'Quality matting'],
    open: 360, close: 1380, interval: 15, min: 30, max: 180, step: 30,
    resources: ['Net A', 'Net B'], unitLabel: 'net',
    bowling: { price: 300, units: 1 },
    prices: [
      { label: 'Weekday', days: WEEKDAYS, start: 0, end: 1440, price: 400, priority: 0 },
      { label: 'Weekend', days: WEEKEND, start: 0, end: 1440, price: 500, priority: 20 },
    ],
  },
  {
    slug: 'pickleball', name: 'Pickleball', sport: 'pickleball', sort: 4,
    tagline: 'Three premium pickleball courts',
    description: 'Cushioned acrylic courts with pro nets. Paddles and balls available on request.',
    features: ['Paddle rental', 'Cushioned surface', 'Floodlights'],
    open: 360, close: 1380, interval: 15, min: 60, max: 180, step: 30,
    resources: ['Court A', 'Court B', 'Court C'], unitLabel: 'court',
    prices: [
      { label: 'Day', days: WEEKDAYS, start: 0, end: 1020, price: 400, priority: 0 },
      { label: 'Evening peak', days: WEEKDAYS, start: 1020, end: 1440, price: 500, priority: 10 },
      { label: 'Weekend', days: WEEKEND, start: 0, end: 1440, price: 600, priority: 20 },
    ],
  },
];

export const DEFAULT_SETTINGS = {
  club: {
    name: 'OG Sports Club',
    tagline: 'Floodlit turf, cricket nets and pickleball courts.',
    address: 'Add your club address in Admin → Settings',
    city: '',
    phone: '+91 90000 00000',
    email: 'hello@example.com',
    whatsapp: '',
    map_url: '',
    hours_note: 'Open daily · 6 AM – 12 AM',
  },
  booking_policy: {
    hold_minutes: 10,
    cancellation_cutoff_hours: 4,
    refund_percent: 100,
    extension_options: [30, 60],
  },
};

export async function seedInitialData(client, { log = console.log } = {}) {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await client.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, JSON.stringify(value)]);
  }

  const { rows } = await client.query('SELECT count(*)::int AS n FROM facility_groups');
  if (rows[0].n > 0) return;

  log('[seed] creating facilities, internal resources and default pricing');
  for (const f of FACILITIES) {
    const { rows: [g] } = await client.query(
      `INSERT INTO facility_groups (slug, name, tagline, description, sport, features, open_minute, close_minute,
         slot_interval_min, min_duration_min, max_duration_min, duration_step_min, supports_bowling_machine,
         bowling_machine_price_per_hour, bowling_machine_units, sort_order, unit_label)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
      [f.slug, f.name, f.tagline, f.description, f.sport, f.features, f.open, f.close, f.interval, f.min, f.max, f.step,
        Boolean(f.bowling), f.bowling ? rupees(f.bowling.price) : 0, f.bowling ? f.bowling.units : 0, f.sort, f.unitLabel || 'unit']
    );
    for (const [i, name] of f.resources.entries()) {
      await client.query('INSERT INTO resources (facility_group_id, name, sort_order) VALUES ($1,$2,$3)', [g.id, name, i]);
    }
    for (const p of f.prices) {
      await client.query(
        `INSERT INTO pricing (facility_group_id, label, days_of_week, start_minute, end_minute, price_per_hour, priority)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [g.id, p.label, p.days, p.start, p.end, rupees(p.price), p.priority]
      );
    }
  }

  if (config.seedDemoData && !config.isProduction) await seedDemoBookings(client, log);
}

async function seedDemoBookings(client, log) {
  log('[seed] adding demo customers and bookings (development only)');
  const tz = config.timezone;
  const today = todayInZone(tz);
  const { rows: [demo] } = await client.query(
    `INSERT INTO users (email, name, phone, is_walk_in) VALUES ('rahul.demo@example.com','Rahul Sharma','9876500001', true) RETURNING id`
  );
  const { rows: [demo2] } = await client.query(
    `INSERT INTO users (email, name, phone, is_walk_in) VALUES ('priya.demo@example.com','Priya Nair','9876500002', true) RETURNING id`
  );
  const { rows: res } = await client.query(
    `SELECT r.id, r.name, g.id AS gid, g.slug FROM resources r JOIN facility_groups g ON g.id = r.facility_group_id ORDER BY g.sort_order, r.sort_order`
  );
  const R = (slug, name) => res.find((r) => r.slug === slug && r.name === name);
  const plan = [
    ['og-turf', 'Turf', 0, 18 * 60, 60, demo, 80000],
    ['og-turf', 'Turf', 0, 20 * 60 + 30, 90, demo2, 120000],
    ['og-oval-turf', 'Oval', 0, 7 * 60, 120, demo, 240000],
    ['cricket-nets', 'Net A', 0, 17 * 60 + 30, 60, demo2, 70000, true],
    ['cricket-nets', 'Net B', 0, 18 * 60, 90, demo, 60000],
    ['pickleball', 'Court A', 0, 19 * 60, 60, demo, 50000],
    ['pickleball', 'Court B', 0, 19 * 60, 90, demo2, 75000],
    ['pickleball', 'Court A', 1, 7 * 60 + 30, 60, demo2, 40000],
    ['og-turf', 'Turf', 1, 19 * 60 + 15, 60, demo2, 80000],
  ];
  let n = 1;
  for (const [slug, rname, dayOffset, startMin, dur, user, amount, bm] of plan) {
    const r = R(slug, rname);
    const date = addDays(today, dayOffset);
    const start = zonedDateTimeToUtc(date, startMin, tz);
    const end = new Date(start.getTime() + dur * 60000);
    const ref = `OG-DEMO${String(n++).padStart(2, '0')}`;
    const { rows: [b] } = await client.query(
      `INSERT INTO bookings (booking_ref, user_id, facility_group_id, resource_id, start_at, end_at, bowling_machine,
         base_amount, addon_amount, total_amount, status, payment_status, source, customer_name, customer_phone)
       SELECT $1, u.id, $2, $3, $4, $5, $6, $7, 0, $7, 'confirmed', 'paid', 'admin', u.name, u.phone FROM users u WHERE u.id = $8
       RETURNING id`,
      [ref, r.gid, r.id, start, end, Boolean(bm), amount, user.id]
    );
    await client.query(
      `INSERT INTO booking_units (booking_id, resource_id, start_at, end_at) VALUES ($1,$2,$3,$4)`,
      [b.id, r.id, start, end]
    );
    await client.query(
      `INSERT INTO payments (booking_id, user_id, provider, amount, status, method, paid_at) VALUES ($1,$2,'upi_offline',$3,'paid','upi', now())`,
      [b.id, user.id, amount]
    );
  }
  // A maintenance block on Net B tomorrow morning and a recurring coaching block on the Oval.
  const nets = R('cricket-nets', 'Net B');
  const tomorrow = addDays(today, 1);
  await client.query(
    `INSERT INTO blocked_slots (facility_group_id, resource_id, start_at, end_at, reason) VALUES ($1,$2,$3,$4,'Net maintenance')`,
    [nets.gid, nets.id, zonedDateTimeToUtc(tomorrow, 9 * 60, tz), zonedDateTimeToUtc(tomorrow, 11 * 60, tz)]
  );
  const oval = R('og-oval-turf', 'Oval');
  await client.query(
    `INSERT INTO recurring_blocks (facility_group_id, resource_id, days_of_week, start_minute, end_minute, valid_from, reason)
     VALUES ($1, NULL, '{1,3,5}', 960, 1080, $2, 'Academy coaching')`,
    [oval.gid, today]
  );
}
