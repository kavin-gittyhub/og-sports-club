// Unit tests for the pure booking logic (no database needed): `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_URL ||= 'postgres://unused/unused';
process.env.RAZORPAY_KEY_SECRET = 'test_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';

const { zonedDateTimeToUtc, utcToZoned, addDays, dayOfWeek, formatMinute } = await import('../src/lib/time.js');
const { computePrice } = await import('../src/services/pricing.js');
const { pickResource, pickResources, isResourceFree, machineAvailable } = await import('../src/services/availability.js');
const { validateTiming } = await import('../src/services/bookings.js');
const { verifyCheckoutSignature, verifyWebhookSignature } = await import('../src/services/payments.js');
const { allowedDurations } = await import('../src/services/facilities.js');

const TZ = 'Asia/Kolkata';

test('IST conversion round-trips', () => {
  const d = zonedDateTimeToUtc('2026-09-15', 19 * 60 + 30, TZ);
  assert.equal(d.toISOString(), '2026-09-15T14:00:00.000Z');
  assert.deepEqual(utcToZoned(d, TZ), { date: '2026-09-15', minute: 1170, dow: 2 });
  assert.equal(zonedDateTimeToUtc('2026-09-15', 1440, TZ).toISOString(), '2026-09-15T18:30:00.000Z');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(dayOfWeek('2026-09-19'), 6);
  assert.equal(formatMinute(0), '12:00 AM');
  assert.equal(formatMinute(19 * 60 + 30), '7:30 PM');
});

const fg = {
  id: 1, name: 'OG Turf', open_minute: 360, close_minute: 1440, slot_interval_min: 15,
  min_duration_min: 60, max_duration_min: 180, duration_step_min: 30, advance_booking_days: 30, min_lead_minutes: 0,
  supports_bowling_machine: false, bowling_machine_price_per_hour: 0, bowling_machine_units: 0,
};
const nets = { ...fg, id: 3, name: 'Cricket Nets', supports_bowling_machine: true, bowling_machine_price_per_hour: 30000, bowling_machine_units: 1 };
const rules = [
  { id: 1, label: 'Day', days_of_week: [1, 2, 3, 4, 5], start_minute: 0, end_minute: 1020, price_per_hour: 60000, priority: 0 },
  { id: 2, label: 'Evening', days_of_week: [1, 2, 3, 4, 5], start_minute: 1020, end_minute: 1440, price_per_hour: 80000, priority: 10 },
  { id: 3, label: 'Weekend', days_of_week: [0, 6], start_minute: 0, end_minute: 1440, price_per_hour: 100000, priority: 20 },
];

test('durations follow min/max/step', () => {
  assert.deepEqual(allowedDurations(fg), [60, 90, 120, 150, 180]);
});

test('price: flat evening hour', () => {
  const p = computePrice({ fg, rules, date: '2026-09-15', startMinute: 1170, durationMin: 60 });
  assert.equal(p.total, 80000);
});

test('price: straddling day/evening is charged per slice', () => {
  // 4:30–5:30 PM → 30 min @600 + 30 min @800 = ₹700
  const p = computePrice({ fg, rules, date: '2026-09-15', startMinute: 990, durationMin: 60 });
  assert.equal(p.total, 70000);
  assert.equal(p.breakdown.length, 2);
});

test('price: weekend rule wins by priority', () => {
  const p = computePrice({ fg, rules, date: '2026-09-19', startMinute: 600, durationMin: 90 });
  assert.equal(p.total, 150000);
});

test('bowling machine priced only for nets, rejected elsewhere', () => {
  const p = computePrice({ fg: nets, rules, date: '2026-09-15', startMinute: 1110, durationMin: 90, bowlingMachine: true });
  assert.equal(p.addon, 45000);
  assert.throws(() => computePrice({ fg, rules, date: '2026-09-15', startMinute: 600, durationMin: 60, bowlingMachine: true }), /only available with Cricket Nets/);
});

test('timing validation: flexible starts allowed, misaligned rejected', () => {
  const now = new Date('2026-09-15T00:00:00Z');
  assert.doesNotThrow(() => validateTiming(fg, { date: '2026-09-16', startMinute: 8 * 60 + 15, durationMin: 60 }, { now }));
  assert.doesNotThrow(() => validateTiming(fg, { date: '2026-09-16', startMinute: 9 * 60, durationMin: 90 }, { now }));
  assert.throws(() => validateTiming(fg, { date: '2026-09-16', startMinute: 8 * 60 + 7, durationMin: 60 }, { now }), /every 15 minutes/);
  assert.throws(() => validateTiming(fg, { date: '2026-09-16', startMinute: 600, durationMin: 45 }, { now }), /durations/);
  assert.throws(() => validateTiming(fg, { date: '2026-09-16', startMinute: 23 * 60 + 30, durationMin: 60 }, { now }), /open/);
  assert.throws(() => validateTiming(fg, { date: '2026-09-14', startMinute: 600, durationMin: 60 }, { now }), /passed/);
});

function occ(resources, busy, machine = []) {
  return { resources, busy: new Map(resources.map((r) => [r.id, busy[r.id] || []])), machine };
}
const T = (h, m = 0) => new Date(Date.UTC(2026, 8, 15, h, m));

test('auto-assign picks a free net and never an occupied one', () => {
  const o = occ([{ id: 1, sort_order: 0 }, { id: 2, sort_order: 1 }], { 1: [{ start: T(12), end: T(13), kind: 'booked' }] });
  assert.equal(pickResource(o, T(12, 30), T(13, 30)).id, 2);
  assert.equal(isResourceFree(o, 1, T(13), T(14)), true); // touching is fine
  const full = occ([{ id: 1, sort_order: 0 }, { id: 2, sort_order: 1 }], {
    1: [{ start: T(12), end: T(13), kind: 'booked' }], 2: [{ start: T(12, 15), end: T(12, 45), kind: 'blocked' }],
  });
  assert.equal(pickResource(full, T(12, 30), T(13, 30)), null);
});

test('best-fit assignment keeps gaps usable', () => {
  // Court 1 has a booking ending exactly at 12:00; court 2 is empty → choose court 1 to avoid fragmenting court 2.
  const o = occ([{ id: 1, sort_order: 0 }, { id: 2, sort_order: 1 }, { id: 3, sort_order: 2 }], { 2: [{ start: T(11), end: T(12), kind: 'booked' }] });
  assert.equal(pickResource(o, T(12), T(13)).id, 2);
});

test('bowling machine capacity respected', () => {
  const o = occ([{ id: 1 }, { id: 2 }], {}, [{ start: T(12), end: T(13) }]);
  assert.equal(machineAvailable(o, nets, T(12, 30), T(13, 30)), false);
  assert.equal(machineAvailable(o, nets, T(13), T(14)), true);
  assert.equal(machineAvailable(o, fg, T(15), T(16)), false);
});

test('Razorpay signatures verified with HMAC-SHA256', () => {
  const sig = crypto.createHmac('sha256', 'test_secret').update('order_1|pay_1').digest('hex');
  assert.equal(verifyCheckoutSignature('order_1', 'pay_1', sig), true);
  assert.equal(verifyCheckoutSignature('order_1', 'pay_2', sig), false);
  const body = Buffer.from('{"event":"payment.captured"}');
  const wsig = crypto.createHmac('sha256', 'whsec_test').update(body).digest('hex');
  assert.equal(verifyWebhookSignature(body, wsig), true);
  assert.equal(verifyWebhookSignature(Buffer.from('{"event":"x"}'), wsig), false);
});

test('quantity: price multiplies per unit, machine charged once', () => {
  const p = computePrice({ fg: nets, rules, date: '2026-09-15', startMinute: 1110, durationMin: 60, quantity: 2, bowlingMachine: true });
  assert.equal(p.unitPrice, 80000);
  assert.equal(p.base, 160000);
  assert.equal(p.addon, 30000);
  assert.equal(p.total, 190000);
});

test('quantity: picks N distinct free units or none', () => {
  const o = occ([{ id: 1, sort_order: 0 }, { id: 2, sort_order: 1 }, { id: 3, sort_order: 2 }], { 1: [{ start: T(12), end: T(13), kind: 'booked' }] });
  const two = pickResources(o, T(12), T(13), 2);
  assert.deepEqual(two.map((r) => r.id).sort(), [2, 3]);
  assert.equal(pickResources(o, T(12), T(13), 3), null);
  assert.deepEqual(pickResources(o, T(14), T(15), 2, { prefer: [3, 1] }).map((r) => r.id), [3, 1]);
});
