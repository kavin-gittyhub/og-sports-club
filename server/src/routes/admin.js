import express from 'express';
import { config } from '../config.js';
import { query, tx, lockFacility } from '../db.js';
import { v, isUuid } from '../lib/validate.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';
import { zonedDateTimeToUtc, utcToZoned, todayInZone, addDays, diffDays } from '../lib/time.js';
import { requireAdmin } from '../middleware/auth.js';
import { getFacilityById, getPricingRules, allowedDurations, maxQuantity } from '../services/facilities.js';
import { computePrice } from '../services/pricing.js';
import { loadOccupancy, isResourceFree, pickResource, pickResources, machineAvailable } from '../services/availability.js';
import { createBooking, updateBooking, cancelBooking, validateTiming, displayStatus, sweepExpiredHolds } from '../services/bookings.js';
import { refundBooking, refundPayment } from '../services/payments.js';
import { getSettings, saveSetting } from '../services/settings.js';
import { audit } from '../services/audit.js';

export const adminRouter = express.Router();
adminRouter.use(requireAdmin);

const tz = () => config.timezone;
const dayStart = (d) => zonedDateTimeToUtc(d, 0, tz());

function rangeFromQuery(q, { defaultDays = 0 } = {}) {
  const today = todayInZone(tz());
  const from = v.date(q.from || today, 'from');
  const to = v.date(q.to || addDays(from, defaultDays), 'to');
  if (to < from) throw badRequest('“To” date must be after “from”.');
  if (diffDays(from, to) > 400) throw badRequest('Please choose a range of at most 400 days.');
  return { from, to, fromUtc: dayStart(from), toUtc: dayStart(addDays(to, 1)) };
}

const BOOKING_SELECT = `
  SELECT b.*, g.slug AS g_slug, g.name AS g_name, g.sport AS g_sport, g.unit_label AS g_unit_label, r.name AS r_name,
         u.name AS u_name, u.email AS u_email, u.phone AS u_phone, u.is_walk_in AS u_walk_in,
         (SELECT json_agg(json_build_object('id', rr.id, 'name', rr.name) ORDER BY rr.sort_order, rr.id)
            FROM booking_units bu JOIN resources rr ON rr.id = bu.resource_id WHERE bu.booking_id = b.id) AS units
  FROM bookings b
  JOIN facility_groups g ON g.id = b.facility_group_id
  JOIN resources r ON r.id = b.resource_id
  JOIN users u ON u.id = b.user_id`;

function adminBookingView(b) {
  const s = utcToZoned(b.start_at, tz());
  const e = utcToZoned(b.end_at, tz());
  return {
    id: b.id,
    ref: b.booking_ref,
    facility: { id: b.facility_group_id, slug: b.g_slug, name: b.g_name, sport: b.g_sport, unitLabel: b.g_unit_label },
    resource: { id: b.resource_id, name: (b.units || []).map((x) => x.name).join(' + ') || b.r_name },
    resources: b.units || [{ id: b.resource_id, name: b.r_name }],
    quantity: b.quantity || 1,
    customer: { id: b.user_id, name: b.customer_name || b.u_name, email: b.u_email, phone: b.customer_phone || b.u_phone, walkIn: b.u_walk_in },
    date: s.date,
    startMinute: s.minute,
    endMinute: e.date === s.date ? e.minute : 1440,
    startAt: b.start_at,
    endAt: b.end_at,
    durationMin: Math.round((new Date(b.end_at) - new Date(b.start_at)) / 60000),
    bowlingMachine: b.bowling_machine,
    amounts: { base: b.base_amount, addon: b.addon_amount, extension: b.extension_amount, total: b.total_amount, refund: b.refund_amount },
    status: b.status,
    displayStatus: displayStatus(b),
    paymentStatus: b.payment_status,
    source: b.source,
    notes: b.notes,
    holdExpiresAt: b.hold_expires_at,
    cancelReason: b.cancel_reason,
    cancelledAt: b.cancelled_at,
    createdAt: b.created_at,
  };
}

// ───────────────────────────────────────────── dashboard

adminRouter.get('/dashboard', async (req, res) => {
  await sweepExpiredHolds();
  const today = todayInZone(tz());
  const from = dayStart(today);
  const to = dayStart(addDays(today, 1));

  const { rows: [counts] } = await query(
    `SELECT count(*) FILTER (WHERE status = 'confirmed')::int AS bookings,
            count(*) FILTER (WHERE status = 'confirmed' AND start_at <= now() AND end_at > now())::int AS live_now,
            COALESCE(sum(total_amount) FILTER (WHERE status = 'confirmed'), 0)::int AS booked_value,
            count(*) FILTER (WHERE status = 'confirmed' AND payment_status = 'pay_at_venue')::int AS pay_at_venue
     FROM bookings WHERE start_at >= $1 AND start_at < $2`,
    [from, to]
  );
  const { rows: [rev] } = await query(
    `SELECT COALESCE(sum(amount - refund_amount), 0)::int AS revenue, count(*)::int AS payments
     FROM payments WHERE status IN ('paid','partially_refunded','refunded','refund_pending') AND paid_at >= $1 AND paid_at < $2`,
    [from, to]
  );
  const { rows: [alerts] } = await query(
    `SELECT (SELECT count(*) FROM bookings WHERE payment_status = 'refund_pending')::int AS refunds_pending,
            (SELECT count(*) FROM bookings WHERE status = 'pending_payment' AND hold_expires_at > now())::int AS holds`
  );

  const { rows: upcoming } = await query(
    `${BOOKING_SELECT} WHERE b.status = 'confirmed' AND b.end_at > now() ORDER BY b.start_at LIMIT 10`
  );

  // Utilisation today per facility = booked minutes / (open minutes × active resources)
  const { rows: groups } = await query(
    `SELECT g.id, g.name, g.slug, g.sport, g.open_minute, g.close_minute,
            (SELECT count(*) FROM resources r WHERE r.facility_group_id = g.id AND r.is_active)::int AS resources
     FROM facility_groups g WHERE g.is_active ORDER BY g.sort_order, g.id`
  );
  const { rows: bookedMins } = await query(
    `SELECT b.facility_group_id, COALESCE(sum(EXTRACT(EPOCH FROM (LEAST(u.end_at, $2) - GREATEST(u.start_at, $1))) / 60), 0)::int AS minutes,
            count(DISTINCT b.id)::int AS n
     FROM booking_units u JOIN bookings b ON b.id = u.booking_id
     WHERE b.status = 'confirmed' AND u.start_at < $2 AND u.end_at > $1 GROUP BY b.facility_group_id`,
    [from, to]
  );
  const utilization = groups.map((g) => {
    const m = bookedMins.find((x) => x.facility_group_id === g.id);
    const capacity = (g.close_minute - g.open_minute) * g.resources;
    return {
      id: g.id, name: g.name, slug: g.slug, sport: g.sport, resources: g.resources, bookings: m?.n || 0,
      bookedMinutes: m?.minutes || 0, capacityMinutes: capacity, percent: capacity ? Math.round(((m?.minutes || 0) / capacity) * 100) : 0,
    };
  });

  const weekStart = addDays(today, -6);
  const { rows: daily } = await query(
    `SELECT to_char(paid_at AT TIME ZONE $3, 'YYYY-MM-DD') AS day, COALESCE(sum(amount - refund_amount), 0)::int AS revenue
     FROM payments WHERE status IN ('paid','partially_refunded','refunded','refund_pending') AND paid_at >= $1 AND paid_at < $2
     GROUP BY 1 ORDER BY 1`,
    [dayStart(weekStart), to, tz()]
  );
  const week = [];
  for (let d = weekStart; d <= today; d = addDays(d, 1)) week.push({ date: d, revenue: daily.find((x) => x.day === d)?.revenue || 0 });

  res.json({
    today,
    todayBookings: counts.bookings,
    liveNow: counts.live_now,
    todayBookedValue: counts.booked_value,
    payAtVenue: counts.pay_at_venue,
    todayRevenue: rev.revenue,
    todayPayments: rev.payments,
    refundsPending: alerts.refunds_pending,
    activeHolds: alerts.holds,
    upcoming: upcoming.map(adminBookingView),
    utilization,
    week,
  });
});

// ───────────────────────────────────────────── timetable

adminRouter.get('/timetable', async (req, res) => {
  const date = v.date(req.query.date || todayInZone(tz()), 'date');
  const from = dayStart(date);
  const to = dayStart(addDays(date, 1));
  const { rows: groups } = await query('SELECT * FROM facility_groups WHERE is_active ORDER BY sort_order, id');
  const { rows: resources } = await query(
    `SELECT r.* FROM resources r JOIN facility_groups g ON g.id = r.facility_group_id WHERE g.is_active AND r.is_active ORDER BY g.sort_order, r.sort_order, r.id`
  );
  const { rows: bookings } = await query(
    `${BOOKING_SELECT} WHERE b.start_at < $2 AND b.end_at > $1
       AND (b.status = 'confirmed' OR (b.status = 'pending_payment' AND b.hold_expires_at > now()))
     ORDER BY b.start_at`,
    [from, to]
  );
  // Blocks (one-off + recurring expanded) per resource
  const blocks = [];
  for (const g of groups) {
    const occ = await loadOccupancy({ query }, g, from, to);
    for (const [rid, ivs] of occ.busy) {
      for (const iv of ivs) {
        if (iv.kind !== 'blocked') continue;
        const s = utcToZoned(iv.start, tz());
        const e = utcToZoned(iv.end, tz());
        blocks.push({
          resourceId: rid,
          startMinute: s.date < date ? 0 : s.minute,
          endMinute: e.date > date ? 1440 : e.minute,
        });
      }
    }
  }
  const { rows: reasons } = await query(
    `SELECT id, facility_group_id, resource_id, start_at, end_at, reason FROM blocked_slots WHERE start_at < $2 AND end_at > $1`,
    [from, to]
  );
  res.json({
    date,
    minMinute: Math.min(...groups.map((g) => g.open_minute), 1440),
    maxMinute: Math.max(...groups.map((g) => g.close_minute), 0),
    facilities: groups.map((g) => ({
      id: g.id, name: g.name, slug: g.slug, sport: g.sport, openMinute: g.open_minute, closeMinute: g.close_minute,
      resources: resources.filter((r) => r.facility_group_id === g.id).map((r) => ({ id: r.id, name: r.name })),
    })),
    bookings: bookings.map(adminBookingView),
    blocks,
    blockNotes: reasons.map((r) => ({ id: r.id, facilityId: r.facility_group_id, resourceId: r.resource_id, reason: r.reason })),
  });
});

// ───────────────────────────────────────────── bookings

adminRouter.get('/bookings', async (req, res) => {
  const { fromUtc, toUtc } = rangeFromQuery(req.query, { defaultDays: 13 });
  const where = ['b.start_at >= $1', 'b.start_at < $2'];
  const params = [fromUtc, toUtc];
  if (req.query.facility) { params.push(v.int(req.query.facility, 'facility')); where.push(`b.facility_group_id = $${params.length}`); }
  if (req.query.status) {
    const st = v.oneOf(req.query.status, 'status', ['pending_payment', 'confirmed', 'cancelled', 'expired']);
    params.push(st); where.push(`b.status = $${params.length}`);
  } else {
    where.push(`b.status <> 'expired'`);
  }
  if (req.query.q) {
    params.push(`%${v.str(req.query.q, 'q', { max: 80 })}%`);
    where.push(`(b.booking_ref ILIKE $${params.length} OR u.name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.phone ILIKE $${params.length} OR b.customer_name ILIKE $${params.length} OR b.customer_phone ILIKE $${params.length})`);
  }
  const limit = v.int(req.query.limit ?? 100, 'limit', { min: 1, max: 500 });
  const offset = v.int(req.query.offset ?? 0, 'offset', { min: 0 });
  const { rows } = await query(
    `${BOOKING_SELECT} WHERE ${where.join(' AND ')} ORDER BY b.start_at ASC LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  const { rows: [{ n }] } = await query(`SELECT count(*)::int AS n FROM bookings b JOIN users u ON u.id = b.user_id WHERE ${where.join(' AND ')}`, params);
  res.json({ bookings: rows.map(adminBookingView), total: n });
});

adminRouter.get('/bookings/:id', async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound();
  const { rows: [b] } = await query(`${BOOKING_SELECT} WHERE b.id = $1`, [req.params.id]);
  if (!b) throw notFound('Booking not found.');
  const { rows: payments } = await query('SELECT * FROM payments WHERE booking_id = $1 ORDER BY created_at', [b.id]);
  const { rows: extensions } = await query('SELECT * FROM booking_extensions WHERE booking_id = $1 ORDER BY created_at', [b.id]);
  const { rows: log } = await query(
    `SELECT a.*, u.name AS actor_name FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE a.entity_type = 'booking' AND a.entity_id = $1 ORDER BY a.created_at`,
    [b.id]
  );
  const { rows: resources } = await query('SELECT id, name, is_active FROM resources WHERE facility_group_id = $1 ORDER BY sort_order, id', [b.facility_group_id]);
  res.json({
    booking: adminBookingView(b),
    resources,
    payments: payments.map(paymentView),
    extensions: extensions.map((e) => ({ id: e.id, minutes: e.minutes, amount: e.amount, status: e.status, createdAt: e.created_at })),
    audit: log.map((a) => ({ id: a.id, action: a.action, actor: a.actor_name || a.actor_role, details: a.details, createdAt: a.created_at })),
  });
});

/** Price + free resources for the manual booking form. */
adminRouter.post('/quote', async (req, res) => {
  const b = req.body || {};
  const fg = await getFacilityById(v.int(b.facilityId, 'facilityId'));
  const date = v.date(b.date, 'date');
  const startMinute = v.int(b.startMinute, 'startMinute', { min: 0, max: 1435 });
  const durationMin = v.int(b.durationMin, 'durationMin', { min: 5, max: 1440 });
  const bowlingMachine = v.bool(b.bowlingMachine, 'bowlingMachine') && fg.supports_bowling_machine;
  const quantity = v.int(b.quantity ?? 1, 'quantity', { min: 1, max: 50 });
  const { startAt, endAt } = validateTiming(fg, { date, startMinute, durationMin }, { admin: true });
  const rules = await getPricingRules(fg.id);
  let price = null;
  let priceError = null;
  try { price = computePrice({ fg, rules, date, startMinute, durationMin, bowlingMachine, quantity }); } catch (e) { priceError = e.message; }
  const occ = await loadOccupancy({ query }, fg, startAt, endAt, { excludeBookingId: isUuid(b.excludeBookingId) ? b.excludeBookingId : null });
  res.json({
    price,
    priceError,
    resources: occ.resources.map((r) => ({ id: r.id, name: r.name, free: isResourceFree(occ, r.id, startAt, endAt) })),
    suggested: pickResource(occ, startAt, endAt)?.id || null,
    suggestedIds: (pickResources(occ, startAt, endAt, quantity) || []).map((r) => r.id),
    maxQuantity: maxQuantity(fg),
    bowlingMachineAvailable: fg.supports_bowling_machine ? machineAvailable(occ, fg, startAt, endAt) : null,
    outsideHours: startMinute < fg.open_minute || startMinute + durationMin > fg.close_minute,
  });
});

async function resolveCustomer(body, actor) {
  if (body.customerId) {
    const { rows: [u] } = await query('SELECT * FROM users WHERE id = $1', [v.uuid(body.customerId, 'customerId')]);
    if (!u) throw badRequest('Customer not found.');
    return u;
  }
  const name = v.str(body.customerName, 'Customer name', { min: 2, max: 80 });
  const phone = v.str(body.customerPhone, 'Customer phone', { max: 20, optional: true, pattern: /^[+\d][\d\s-]{6,18}$/ }) || null;
  const email = v.str(body.customerEmail, 'Customer email', { max: 120, optional: true, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ }) || null;
  if (phone) {
    const { rows: [existing] } = await query('SELECT * FROM users WHERE phone = $1 ORDER BY created_at LIMIT 1', [phone]);
    if (existing) return existing;
  }
  if (email) {
    const { rows: [existing] } = await query('SELECT * FROM users WHERE lower(email) = lower($1) LIMIT 1', [email]);
    if (existing) return existing;
  }
  const { rows: [u] } = await query(
    'INSERT INTO users (name, phone, email, is_walk_in) VALUES ($1,$2,$3,true) RETURNING *',
    [name, phone, email]
  );
  await audit({ actor, action: 'customer.walk_in_create', entityType: 'user', entityId: u.id, details: { name, phone } });
  return u;
}

adminRouter.post('/bookings', async (req, res) => {
  const b = req.body || {};
  const fg = await getFacilityById(v.int(b.facilityId, 'facilityId'));
  const customer = await resolveCustomer(b, req.user);
  const booking = await createBooking({
    fg,
    user: customer,
    actor: req.user,
    date: v.date(b.date, 'date'),
    startMinute: v.int(b.startMinute, 'startMinute', { min: 0, max: 1435 }),
    durationMin: v.int(b.durationMin, 'durationMin', { min: 5, max: 1440 }),
    bowlingMachine: v.bool(b.bowlingMachine, 'bowlingMachine'),
    quantity: v.int(b.quantity ?? 1, 'quantity', { min: 1, max: 50 }),
    admin: {
      resourceIds: Array.isArray(b.resourceIds) && b.resourceIds.length
        ? b.resourceIds.map((x) => v.int(x, 'resourceIds', { min: 1 }))
        : (b.resourceId ? [v.int(b.resourceId, 'resourceId', { min: 1 })] : undefined),
      paymentMode: v.oneOf(b.paymentMode || 'pay_at_venue', 'paymentMode', ['pay_at_venue', 'cash', 'upi_offline', 'card_offline']),
      amountOverride: v.int(b.amount, 'amount', { min: 0, max: 10_000_000, optional: true }),
      notes: v.str(b.notes, 'notes', { max: 500, optional: true }),
    },
    ip: req.ip,
  });
  const { rows: [full] } = await query(`${BOOKING_SELECT} WHERE b.id = $1`, [booking.id]);
  res.status(201).json({ booking: adminBookingView(full) });
});

adminRouter.patch('/bookings/:id', async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound();
  const b = req.body || {};
  const changes = {
    date: v.date(b.date, 'date', { optional: true }),
    startMinute: v.int(b.startMinute, 'startMinute', { min: 0, max: 1435, optional: true }),
    durationMin: v.int(b.durationMin, 'durationMin', { min: 5, max: 1440, optional: true }),
    resourceId: v.int(b.resourceId, 'resourceId', { optional: true }),
    resourceIds: Array.isArray(b.resourceIds) && b.resourceIds.length ? b.resourceIds.map((x) => v.int(x, 'resourceIds', { min: 1 })) : undefined,
    bowlingMachine: v.bool(b.bowlingMachine, 'bowlingMachine', { optional: true }),
    totalAmount: v.int(b.totalAmount, 'totalAmount', { min: 0, max: 10_000_000, optional: true }),
    reprice: v.bool(b.reprice, 'reprice'),
    notes: b.notes === undefined ? undefined : v.str(b.notes, 'notes', { max: 500 }),
    customerName: v.str(b.customerName, 'customerName', { max: 80, optional: true }),
    customerPhone: v.str(b.customerPhone, 'customerPhone', { max: 20, optional: true }),
    paymentStatus: v.oneOf(b.paymentStatus, 'paymentStatus', ['unpaid', 'paid', 'pay_at_venue'], { optional: true }),
  };
  for (const k of Object.keys(changes)) if (changes[k] === undefined) delete changes[k];
  await updateBooking({ bookingId: req.params.id, actor: req.user, changes, ip: req.ip });
  const { rows: [full] } = await query(`${BOOKING_SELECT} WHERE b.id = $1`, [req.params.id]);
  res.json({ booking: adminBookingView(full) });
});

adminRouter.post('/bookings/:id/cancel', async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound();
  const refundAmount = v.int(req.body?.refundAmount, 'refundAmount', { min: 0, optional: true });
  const { refundAmount: refund } = await cancelBooking({
    bookingId: req.params.id, actor: req.user, isAdmin: true, ip: req.ip,
    reason: v.str(req.body?.reason, 'reason', { max: 300, optional: true }) || 'Cancelled by club',
    refundAmount,
  });
  let refundResult = { refunded: 0, errors: [] };
  if (refund > 0) refundResult = await refundBooking({ bookingId: req.params.id, amount: refund, reason: 'Cancelled by club', actor: req.user });
  const { rows: [full] } = await query(`${BOOKING_SELECT} WHERE b.id = $1`, [req.params.id]);
  res.json({ booking: adminBookingView(full), refund: { requested: refund, processed: refundResult.refunded, errors: refundResult.errors } });
});

/** Record an offline payment (cash/UPI at desk) against a booking. */
adminRouter.post('/bookings/:id/payments', async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound();
  const method = v.oneOf(req.body?.method, 'method', ['cash', 'upi_offline', 'card_offline']);
  const amount = v.int(req.body?.amount, 'amount', { min: 1, max: 10_000_000 });
  const { rows: [b] } = await query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
  if (!b) throw notFound('Booking not found.');
  await query(
    `INSERT INTO payments (booking_id, user_id, provider, amount, status, method, paid_at) VALUES ($1,$2,$3,$4,'paid',$5, now())`,
    [b.id, b.user_id, method, amount, method === 'cash' ? 'cash' : method === 'card_offline' ? 'card' : 'upi']
  );
  await query(`UPDATE bookings SET payment_status = 'paid', updated_at = now() WHERE id = $1 AND payment_status IN ('unpaid','pay_at_venue')`, [b.id]);
  await audit({ actor: req.user, ip: req.ip, action: 'payment.offline_recorded', entityType: 'booking', entityId: b.id, details: { method, amount } });
  const { rows: [full] } = await query(`${BOOKING_SELECT} WHERE b.id = $1`, [b.id]);
  res.status(201).json({ booking: adminBookingView(full) });
});

// ───────────────────────────────────────────── blocks

async function overlappingBookings(fgId, resourceId, start, end) {
  const { rows } = await query(
    `${BOOKING_SELECT} WHERE b.facility_group_id = $1
       AND ($2::int IS NULL OR EXISTS (SELECT 1 FROM booking_units x WHERE x.booking_id = b.id AND x.resource_id = $2))
       AND b.status IN ('confirmed','pending_payment') AND b.start_at < $4 AND b.end_at > $3 ORDER BY b.start_at`,
    [fgId, resourceId, start, end]
  );
  return rows.map(adminBookingView);
}

adminRouter.get('/blocks', async (req, res) => {
  const { fromUtc, toUtc } = rangeFromQuery(req.query, { defaultDays: 60 });
  const { rows } = await query(
    `SELECT s.*, g.name AS g_name, r.name AS r_name, u.name AS by_name FROM blocked_slots s
     JOIN facility_groups g ON g.id = s.facility_group_id LEFT JOIN resources r ON r.id = s.resource_id LEFT JOIN users u ON u.id = s.created_by
     WHERE s.end_at > $1 AND s.start_at < $2 ORDER BY s.start_at`,
    [fromUtc, toUtc]
  );
  const { rows: rec } = await query(
    `SELECT rb.*, g.name AS g_name, r.name AS r_name FROM recurring_blocks rb
     JOIN facility_groups g ON g.id = rb.facility_group_id LEFT JOIN resources r ON r.id = rb.resource_id
     ORDER BY rb.is_active DESC, g.sort_order, rb.start_minute`
  );
  res.json({
    blocks: rows.map((s) => {
      const a = utcToZoned(s.start_at, tz());
      const e = utcToZoned(s.end_at, tz());
      return {
        id: s.id, facilityId: s.facility_group_id, facilityName: s.g_name, resourceId: s.resource_id, resourceName: s.r_name,
        startAt: s.start_at, endAt: s.end_at, startDate: a.date, startMinute: a.minute, endDate: e.date, endMinute: e.minute,
        reason: s.reason, createdBy: s.by_name,
      };
    }),
    recurring: rec.map((r) => ({
      id: r.id, facilityId: r.facility_group_id, facilityName: r.g_name, resourceId: r.resource_id, resourceName: r.r_name,
      days: r.days_of_week, startMinute: r.start_minute, endMinute: r.end_minute, validFrom: r.valid_from, validUntil: r.valid_until,
      reason: r.reason, active: r.is_active,
    })),
  });
});

async function validateResourceForGroup(fgId, resourceId) {
  if (!resourceId) return null;
  const { rows: [r] } = await query('SELECT id FROM resources WHERE id = $1 AND facility_group_id = $2', [resourceId, fgId]);
  if (!r) throw badRequest('That resource does not belong to the selected facility.');
  return resourceId;
}

adminRouter.post('/blocks', async (req, res) => {
  const b = req.body || {};
  const fgId = v.int(b.facilityId, 'facilityId');
  await getFacilityById(fgId);
  const resourceId = await validateResourceForGroup(fgId, v.int(b.resourceId, 'resourceId', { optional: true }));
  const startDate = v.date(b.startDate, 'startDate');
  const endDate = v.date(b.endDate || b.startDate, 'endDate');
  const startMinute = v.int(b.startMinute ?? 0, 'startMinute', { min: 0, max: 1440 });
  const endMinute = v.int(b.endMinute ?? 1440, 'endMinute', { min: 0, max: 1440 });
  const start = zonedDateTimeToUtc(startDate, startMinute, tz());
  const end = zonedDateTimeToUtc(endDate, endMinute, tz());
  if (end <= start) throw badRequest('The block must end after it starts.');
  const reason = v.str(b.reason, 'reason', { max: 200 }) || 'Blocked';
  const block = await tx(async (client) => {
    await lockFacility(client, fgId);
    const { rows: [row] } = await client.query(
      `INSERT INTO blocked_slots (facility_group_id, resource_id, start_at, end_at, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [fgId, resourceId, start, end, reason, req.user.id]
    );
    return row;
  });
  await audit({ actor: req.user, ip: req.ip, action: 'block.create', entityType: 'blocked_slot', entityId: block.id, details: { fgId, resourceId, start, end, reason } });
  res.status(201).json({ block, conflicts: await overlappingBookings(fgId, resourceId, start, end) });
});

adminRouter.delete('/blocks/:id', async (req, res) => {
  const id = v.int(req.params.id, 'id');
  const { rowCount } = await query('DELETE FROM blocked_slots WHERE id = $1', [id]);
  if (!rowCount) throw notFound('Block not found.');
  await audit({ actor: req.user, ip: req.ip, action: 'block.delete', entityType: 'blocked_slot', entityId: id });
  res.json({ ok: true });
});

adminRouter.post('/recurring-blocks', async (req, res) => {
  const b = req.body || {};
  const fgId = v.int(b.facilityId, 'facilityId');
  await getFacilityById(fgId);
  const resourceId = await validateResourceForGroup(fgId, v.int(b.resourceId, 'resourceId', { optional: true }));
  const days = v.days(b.days, 'Days');
  const startMinute = v.int(b.startMinute, 'startMinute', { min: 0, max: 1435 });
  const endMinute = v.int(b.endMinute, 'endMinute', { min: 5, max: 1440 });
  if (endMinute <= startMinute) throw badRequest('End time must be after start time.');
  const validFrom = v.date(b.validFrom || todayInZone(tz()), 'validFrom');
  const validUntil = v.date(b.validUntil, 'validUntil', { optional: true }) || null;
  if (validUntil && validUntil < validFrom) throw badRequest('“Until” must be after “from”.');
  const reason = v.str(b.reason, 'reason', { max: 200 }) || 'Recurring block';
  const { rows: [row] } = await query(
    `INSERT INTO recurring_blocks (facility_group_id, resource_id, days_of_week, start_minute, end_minute, valid_from, valid_until, reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [fgId, resourceId, days, startMinute, endMinute, validFrom, validUntil, reason, req.user.id]
  );
  await audit({ actor: req.user, ip: req.ip, action: 'recurring_block.create', entityType: 'recurring_block', entityId: row.id, details: b });
  // Report upcoming bookings (next 60 days) that clash with the new rule.
  const { rows: upcoming } = await query(
    `${BOOKING_SELECT} WHERE b.facility_group_id = $1
       AND ($2::int IS NULL OR EXISTS (SELECT 1 FROM booking_units x WHERE x.booking_id = b.id AND x.resource_id = $2)) AND b.status = 'confirmed'
       AND b.start_at > now() AND b.start_at < now() + interval '60 days'`,
    [fgId, resourceId]
  );
  const conflicts = upcoming.map(adminBookingView).filter((bk) => {
    const dow = new Date(`${bk.date}T00:00:00Z`).getUTCDay();
    return days.includes(dow) && bk.date >= validFrom && (!validUntil || bk.date <= validUntil)
      && bk.startMinute < endMinute && bk.endMinute > startMinute;
  });
  res.status(201).json({ recurring: row, conflicts });
});

adminRouter.patch('/recurring-blocks/:id', async (req, res) => {
  const id = v.int(req.params.id, 'id');
  const active = v.bool(req.body?.active, 'active');
  const { rows: [row] } = await query('UPDATE recurring_blocks SET is_active = $2 WHERE id = $1 RETURNING *', [id, active]);
  if (!row) throw notFound();
  await audit({ actor: req.user, ip: req.ip, action: 'recurring_block.update', entityType: 'recurring_block', entityId: id, details: { active } });
  res.json({ recurring: row });
});

adminRouter.delete('/recurring-blocks/:id', async (req, res) => {
  const id = v.int(req.params.id, 'id');
  const { rowCount } = await query('DELETE FROM recurring_blocks WHERE id = $1', [id]);
  if (!rowCount) throw notFound();
  await audit({ actor: req.user, ip: req.ip, action: 'recurring_block.delete', entityType: 'recurring_block', entityId: id });
  res.json({ ok: true });
});

// ───────────────────────────────────────────── facilities, resources, pricing

function facilityAdminView(g, resources, pricing) {
  return {
    id: g.id, slug: g.slug, name: g.name, tagline: g.tagline, description: g.description, sport: g.sport, imageUrl: g.image_url,
    features: g.features, openMinute: g.open_minute, closeMinute: g.close_minute, slotIntervalMin: g.slot_interval_min,
    minDurationMin: g.min_duration_min, maxDurationMin: g.max_duration_min, durationStepMin: g.duration_step_min,
    advanceBookingDays: g.advance_booking_days, minLeadMinutes: g.min_lead_minutes,
    supportsBowlingMachine: g.supports_bowling_machine, bowlingMachinePricePerHour: g.bowling_machine_price_per_hour,
    bowlingMachineUnits: g.bowling_machine_units, isActive: g.is_active, sortOrder: g.sort_order, durations: allowedDurations(g),
    unitLabel: g.unit_label, maxUnitsPerBooking: g.max_units_per_booking,
    resources: resources.filter((r) => r.facility_group_id === g.id).map((r) => ({ id: r.id, name: r.name, isActive: r.is_active, sortOrder: r.sort_order })),
    pricing: pricing.filter((p) => p.facility_group_id === g.id).map(pricingView),
  };
}

function pricingView(p) {
  return {
    id: p.id, facilityId: p.facility_group_id, label: p.label, days: p.days_of_week, startMinute: p.start_minute, endMinute: p.end_minute,
    pricePerHour: p.price_per_hour, priority: p.priority, validFrom: p.valid_from, validUntil: p.valid_until, isActive: p.is_active,
  };
}

adminRouter.get('/facilities', async (req, res) => {
  const { rows: groups } = await query('SELECT * FROM facility_groups ORDER BY sort_order, id');
  const { rows: resources } = await query('SELECT * FROM resources ORDER BY sort_order, id');
  const { rows: pricing } = await query('SELECT * FROM pricing ORDER BY facility_group_id, priority DESC, start_minute, id');
  res.json({ facilities: groups.map((g) => facilityAdminView(g, resources, pricing)) });
});

function facilityFields(b, { partial }) {
  const o = partial ? { optional: true } : {};
  const f = {
    name: v.str(b.name, 'Name', { min: 2, max: 60, ...(partial ? { optional: true } : {}) }),
    tagline: v.str(b.tagline, 'Tagline', { max: 120, optional: true }),
    description: v.str(b.description, 'Description', { max: 1000, optional: true }),
    sport: v.oneOf(b.sport, 'Sport', ['football', 'oval', 'cricket', 'pickleball', 'badminton', 'tennis', 'basketball', 'other'], { optional: true }),
    image_url: b.imageUrl === '' ? null : v.str(b.imageUrl, 'Image URL', { max: 500, optional: true, pattern: /^https:\/\/\S+$/ }),
    features: b.features === undefined ? undefined : (Array.isArray(b.features) ? b.features : []).map((x) => v.str(x, 'Feature', { max: 40 })).filter(Boolean).slice(0, 8),
    open_minute: v.int(b.openMinute, 'Opening time', { min: 0, max: 1435, ...o }),
    close_minute: v.int(b.closeMinute, 'Closing time', { min: 5, max: 1440, ...o }),
    slot_interval_min: b.slotIntervalMin === undefined ? undefined : v.oneOf(Number(b.slotIntervalMin), 'Start-time interval', [5, 10, 15, 20, 30, 60]),
    min_duration_min: v.int(b.minDurationMin, 'Minimum duration', { min: 15, max: 1440, ...o }),
    max_duration_min: v.int(b.maxDurationMin, 'Maximum duration', { min: 15, max: 1440, ...o }),
    duration_step_min: v.int(b.durationStepMin, 'Duration step', { min: 5, max: 240, ...o }),
    advance_booking_days: v.int(b.advanceBookingDays, 'Advance booking days', { min: 0, max: 365, optional: true }),
    min_lead_minutes: v.int(b.minLeadMinutes, 'Minimum notice', { min: 0, max: 10080, optional: true }),
    bowling_machine_price_per_hour: v.int(b.bowlingMachinePricePerHour, 'Bowling machine price', { min: 0, max: 10_000_000, optional: true }),
    bowling_machine_units: v.int(b.bowlingMachineUnits, 'Bowling machines', { min: 0, max: 20, optional: true }),
    supports_bowling_machine: v.bool(b.supportsBowlingMachine, 'supportsBowlingMachine', { optional: true }),
    is_active: v.bool(b.isActive, 'isActive', { optional: true }),
    sort_order: v.int(b.sortOrder, 'sortOrder', { min: 0, max: 1000, optional: true }),
    unit_label: v.str(b.unitLabel, 'Unit name', { max: 20, optional: true, pattern: /^[A-Za-z ]+$/ }),
    max_units_per_booking: v.int(b.maxUnitsPerBooking, 'Max per booking', { min: 0, max: 50, optional: true }),
  };
  for (const k of ['min_duration_min', 'max_duration_min', 'duration_step_min']) {
    if (f[k] !== undefined && f[k] % 5) throw badRequest('Durations must be multiples of 5 minutes.');
  }
  for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k];
  return f;
}

adminRouter.post('/facilities', async (req, res) => {
  const b = req.body || {};
  const f = facilityFields(b, { partial: false });
  const slug = v.str(b.slug || f.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), 'slug', { max: 60, pattern: /^[a-z0-9-]+$/ });
  const resourceCount = v.int(b.resourceCount ?? 1, 'resourceCount', { min: 1, max: 20 });
  const resourcePrefix = v.str(b.resourcePrefix, 'resourcePrefix', { max: 30 }) || 'Unit';
  const pricePerHour = v.int(b.pricePerHour, 'Price per hour', { min: 0, max: 10_000_000 });
  const row = await tx(async (client) => {
    const cols = ['slug', ...Object.keys(f)];
    const vals = [slug, ...Object.values(f)];
    const { rows: [g] } = await client.query(
      `INSERT INTO facility_groups (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, vals
    ).catch((err) => { if (err.code === '23505') throw conflict('A facility with that name already exists.'); throw err; });
    for (let i = 0; i < resourceCount; i++) {
      await client.query('INSERT INTO resources (facility_group_id, name, sort_order) VALUES ($1,$2,$3)',
        [g.id, resourceCount === 1 ? resourcePrefix : `${resourcePrefix} ${String.fromCharCode(65 + i)}`, i]);
    }
    await client.query('INSERT INTO pricing (facility_group_id, label, price_per_hour) VALUES ($1, $2, $3)', [g.id, 'Standard', pricePerHour]);
    return g;
  });
  await audit({ actor: req.user, ip: req.ip, action: 'facility.create', entityType: 'facility', entityId: row.id, details: { slug } });
  res.status(201).json({ id: row.id });
});

adminRouter.patch('/facilities/:id', async (req, res) => {
  const id = v.int(req.params.id, 'id');
  const before = await getFacilityById(id);
  const f = facilityFields(req.body || {}, { partial: true });
  if (!Object.keys(f).length) throw badRequest('Nothing to update.');
  const merged = { ...before, ...f };
  if (merged.close_minute <= merged.open_minute) throw badRequest('Closing time must be after opening time.');
  if (merged.max_duration_min < merged.min_duration_min) throw badRequest('Maximum duration must be at least the minimum duration.');
  if (merged.open_minute % merged.slot_interval_min) throw badRequest('Opening time must line up with the start-time interval.');
  const cols = Object.keys(f);
  const { rows: [row] } = await query(
    `UPDATE facility_groups SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, ...Object.values(f)]
  );
  await audit({ actor: req.user, ip: req.ip, action: 'facility.update', entityType: 'facility', entityId: id, details: f });
  res.json({ facility: row });
});

adminRouter.post('/facilities/:id/resources', async (req, res) => {
  const id = v.int(req.params.id, 'id');
  await getFacilityById(id);
  const name = v.str(req.body?.name, 'Name', { min: 1, max: 40 });
  const { rows: [r] } = await query(
    `INSERT INTO resources (facility_group_id, name, sort_order)
     VALUES ($1, $2, (SELECT COALESCE(max(sort_order), -1) + 1 FROM resources WHERE facility_group_id = $1)) RETURNING *`,
    [id, name]
  ).catch((err) => { if (err.code === '23505') throw conflict('A resource with that name already exists.'); throw err; });
  await audit({ actor: req.user, ip: req.ip, action: 'resource.create', entityType: 'resource', entityId: r.id, details: { name, facilityId: id } });
  res.status(201).json({ resource: r });
});

adminRouter.patch('/resources/:id', async (req, res) => {
  const id = v.int(req.params.id, 'id');
  const name = v.str(req.body?.name, 'Name', { min: 1, max: 40, optional: true });
  const active = v.bool(req.body?.isActive, 'isActive', { optional: true });
  const { rows: [r] } = await query(
    'UPDATE resources SET name = COALESCE($2, name), is_active = COALESCE($3, is_active) WHERE id = $1 RETURNING *',
    [id, name ?? null, active ?? null]
  );
  if (!r) throw notFound('Resource not found.');
  const { rows: [{ n }] } = await query(
    `SELECT count(*)::int AS n FROM booking_units u JOIN bookings b ON b.id = u.booking_id
     WHERE u.resource_id = $1 AND b.status = 'confirmed' AND b.start_at > now()`, [id]
  );
  await audit({ actor: req.user, ip: req.ip, action: 'resource.update', entityType: 'resource', entityId: id, details: { name, active } });
  res.json({ resource: r, futureBookings: n });
});

function pricingFields(b, partial) {
  const o = partial ? { optional: true } : {};
  const f = {
    label: v.str(b.label, 'Label', { min: 1, max: 40, ...o }),
    days_of_week: b.days === undefined ? undefined : (b.days === null || (Array.isArray(b.days) && b.days.length === 7) ? null : v.days(b.days, 'Days')),
    start_minute: v.int(b.startMinute, 'From', { min: 0, max: 1435, ...o }),
    end_minute: v.int(b.endMinute, 'To', { min: 5, max: 1440, ...o }),
    price_per_hour: v.int(b.pricePerHour, 'Price per hour', { min: 0, max: 10_000_000, ...o }),
    priority: v.int(b.priority, 'Priority', { min: 0, max: 1000, optional: true }),
    valid_from: b.validFrom === '' ? null : v.date(b.validFrom, 'Valid from', { optional: true }),
    valid_until: b.validUntil === '' ? null : v.date(b.validUntil, 'Valid until', { optional: true }),
    is_active: v.bool(b.isActive, 'isActive', { optional: true }),
  };
  for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k];
  if (f.start_minute !== undefined && f.end_minute !== undefined && f.end_minute <= f.start_minute) throw badRequest('“To” must be after “From”.');
  return f;
}

adminRouter.post('/pricing', async (req, res) => {
  const fgId = v.int(req.body?.facilityId, 'facilityId');
  await getFacilityById(fgId);
  const f = pricingFields(req.body || {}, false);
  const cols = ['facility_group_id', ...Object.keys(f)];
  const { rows: [row] } = await query(
    `INSERT INTO pricing (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
    [fgId, ...Object.values(f)]
  );
  await audit({ actor: req.user, ip: req.ip, action: 'pricing.create', entityType: 'pricing', entityId: row.id, details: f });
  res.status(201).json({ rule: pricingView(row) });
});

adminRouter.patch('/pricing/:id', async (req, res) => {
  const id = v.int(req.params.id, 'id');
  const f = pricingFields(req.body || {}, true);
  if (!Object.keys(f).length) throw badRequest('Nothing to update.');
  const cols = Object.keys(f);
  const { rows: [row] } = await query(
    `UPDATE pricing SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...Object.values(f)]
  );
  if (!row) throw notFound('Price rule not found.');
  if (row.end_minute <= row.start_minute) throw badRequest('“To” must be after “From”.');
  await audit({ actor: req.user, ip: req.ip, action: 'pricing.update', entityType: 'pricing', entityId: id, details: f });
  res.json({ rule: pricingView(row) });
});

adminRouter.delete('/pricing/:id', async (req, res) => {
  const id = v.int(req.params.id, 'id');
  const { rowCount } = await query('DELETE FROM pricing WHERE id = $1', [id]);
  if (!rowCount) throw notFound('Price rule not found.');
  await audit({ actor: req.user, ip: req.ip, action: 'pricing.delete', entityType: 'pricing', entityId: id });
  res.json({ ok: true });
});

/** Price preview for the pricing page. */
adminRouter.get('/pricing/preview', async (req, res) => {
  const fg = await getFacilityById(v.int(req.query.facilityId, 'facilityId'));
  const date = v.date(req.query.date || todayInZone(tz()), 'date');
  const rules = await getPricingRules(fg.id);
  const out = [];
  for (let m = fg.open_minute; m + 60 <= fg.close_minute; m += 60) {
    try {
      out.push({ startMinute: m, amount: computePrice({ fg, rules, date, startMinute: m, durationMin: 60 }).total });
    } catch { out.push({ startMinute: m, amount: null }); }
  }
  res.json({ date, hours: out });
});

// ───────────────────────────────────────────── customers

adminRouter.get('/customers', async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.q) {
    params.push(`%${v.str(req.query.q, 'q', { max: 80 })}%`);
    where = `WHERE u.name ILIKE $1 OR u.email ILIKE $1 OR u.phone ILIKE $1`;
  }
  const limit = v.int(req.query.limit ?? 100, 'limit', { min: 1, max: 500 });
  const offset = v.int(req.query.offset ?? 0, 'offset', { min: 0 });
  const { rows } = await query(
    `SELECT u.*,
       (SELECT count(*) FROM bookings b WHERE b.user_id = u.id AND b.status = 'confirmed')::int AS bookings,
       (SELECT COALESCE(sum(p.amount - p.refund_amount), 0) FROM payments p WHERE p.user_id = u.id AND p.status IN ('paid','partially_refunded','refunded'))::int AS spent,
       (SELECT max(b.start_at) FROM bookings b WHERE b.user_id = u.id AND b.status = 'confirmed') AS last_booking
     FROM users u ${where} ORDER BY u.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  const { rows: [{ n }] } = await query(`SELECT count(*)::int AS n FROM users u ${where}`, params);
  res.json({
    total: n,
    customers: rows.map((u) => ({
      id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, isBlocked: u.is_blocked, isWalkIn: u.is_walk_in,
      hasAccount: Boolean(u.clerk_user_id), bookings: u.bookings, spent: u.spent, lastBooking: u.last_booking, createdAt: u.created_at,
    })),
  });
});

adminRouter.get('/customers/:id', async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound();
  const { rows: [u] } = await query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (!u) throw notFound('Customer not found.');
  const { rows } = await query(`${BOOKING_SELECT} WHERE b.user_id = $1 AND b.status <> 'expired' ORDER BY b.start_at DESC LIMIT 100`, [u.id]);
  res.json({
    customer: { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, isBlocked: u.is_blocked, isWalkIn: u.is_walk_in, hasAccount: Boolean(u.clerk_user_id), createdAt: u.created_at },
    bookings: rows.map(adminBookingView),
  });
});

adminRouter.patch('/customers/:id', async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound();
  const b = req.body || {};
  const role = v.oneOf(b.role, 'role', ['customer', 'admin'], { optional: true });
  const blocked = v.bool(b.isBlocked, 'isBlocked', { optional: true });
  if (req.params.id === req.user.id && (role === 'customer' || blocked)) throw badRequest('You cannot remove your own admin access.');
  const { rows: [u] } = await query(
    `UPDATE users SET role = COALESCE($2, role), is_blocked = COALESCE($3, is_blocked), name = COALESCE($4, name), phone = COALESCE($5, phone), updated_at = now()
     WHERE id = $1 RETURNING *`,
    [req.params.id, role ?? null, blocked ?? null, v.str(b.name, 'name', { max: 80, optional: true }) ?? null, v.str(b.phone, 'phone', { max: 20, optional: true }) ?? null]
  );
  if (!u) throw notFound('Customer not found.');
  await audit({ actor: req.user, ip: req.ip, action: 'customer.update', entityType: 'user', entityId: u.id, details: { role, blocked } });
  res.json({ ok: true });
});

// ───────────────────────────────────────────── payments

function paymentView(p) {
  return {
    id: p.id, bookingId: p.booking_id, extensionId: p.extension_id, provider: p.provider, orderId: p.provider_order_id,
    paymentId: p.provider_payment_id, amount: p.amount, refundAmount: p.refund_amount, status: p.status, method: p.method,
    failureReason: p.failure_reason, paidAt: p.paid_at, createdAt: p.created_at,
    bookingRef: p.booking_ref, customerName: p.u_name, facilityName: p.g_name,
  };
}

adminRouter.get('/payments', async (req, res) => {
  const { fromUtc, toUtc } = rangeFromQuery({ from: req.query.from || addDays(todayInZone(tz()), -29), to: req.query.to });
  const params = [fromUtc, toUtc];
  let extra = '';
  if (req.query.status) {
    params.push(v.oneOf(req.query.status, 'status', ['created', 'paid', 'failed', 'refund_pending', 'refunded', 'partially_refunded']));
    extra = `AND p.status = $3`;
  }
  const { rows } = await query(
    `SELECT p.*, b.booking_ref, COALESCE(b.customer_name, u.name) AS u_name, g.name AS g_name FROM payments p
     JOIN bookings b ON b.id = p.booking_id JOIN users u ON u.id = b.user_id JOIN facility_groups g ON g.id = b.facility_group_id
     WHERE p.created_at >= $1 AND p.created_at < $2 ${extra} ORDER BY p.created_at DESC LIMIT 500`,
    params
  );
  res.json({ payments: rows.map(paymentView) });
});

adminRouter.post('/payments/:id/refund', async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound();
  const amount = v.int(req.body?.amount, 'amount', { min: 1 });
  const { rows: [p] } = await query('SELECT * FROM payments WHERE id = $1', [req.params.id]);
  if (!p) throw notFound('Payment not found.');
  if (!['paid', 'partially_refunded', 'refund_pending'].includes(p.status)) throw badRequest('This payment cannot be refunded.');
  await query('UPDATE bookings SET refund_amount = refund_amount + $2, updated_at = now() WHERE id = $1', [p.booking_id, Math.min(amount, p.amount - p.refund_amount)]);
  const r = await refundPayment({ paymentRowId: p.id, amount, reason: v.str(req.body?.reason, 'reason', { max: 200, optional: true }) || 'Refund by club', actor: req.user });
  if (r.error) throw badRequest(`Refund failed: ${r.error}`, 'REFUND_FAILED');
  res.json({ refunded: r.refunded });
});

// ───────────────────────────────────────────── reports

async function buildReport(from, to) {
  const fromUtc = dayStart(from);
  const toUtc = dayStart(addDays(to, 1));
  const { rows: [totals] } = await query(
    `SELECT COALESCE(sum(amount), 0)::int AS gross, COALESCE(sum(refund_amount), 0)::int AS refunds, count(*)::int AS payments
     FROM payments WHERE status IN ('paid','partially_refunded','refunded','refund_pending') AND paid_at >= $1 AND paid_at < $2`,
    [fromUtc, toUtc]
  );
  const { rows: [bk] } = await query(
    `SELECT count(*) FILTER (WHERE status = 'confirmed')::int AS confirmed,
            count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
            COALESCE(sum(quantity * EXTRACT(EPOCH FROM (end_at - start_at)) / 3600) FILTER (WHERE status = 'confirmed'), 0)::float AS hours,
            count(*) FILTER (WHERE status = 'confirmed' AND bowling_machine)::int AS bowling
     FROM bookings WHERE start_at >= $1 AND start_at < $2`,
    [fromUtc, toUtc]
  );
  const { rows: byFacility } = await query(
    `SELECT g.id, g.name,
       count(b.*) FILTER (WHERE b.status = 'confirmed')::int AS bookings,
       COALESCE(sum(b.quantity * EXTRACT(EPOCH FROM (b.end_at - b.start_at)) / 3600) FILTER (WHERE b.status = 'confirmed'), 0)::float AS hours,
       COALESCE(sum(b.total_amount - b.refund_amount) FILTER (WHERE b.status = 'confirmed'), 0)::int AS value,
       COALESCE(sum(b.addon_amount) FILTER (WHERE b.status = 'confirmed'), 0)::int AS addons
     FROM facility_groups g LEFT JOIN bookings b ON b.facility_group_id = g.id AND b.start_at >= $1 AND b.start_at < $2
     GROUP BY g.id, g.name, g.sort_order ORDER BY g.sort_order, g.id`,
    [fromUtc, toUtc]
  );
  const { rows: byDay } = await query(
    `SELECT to_char(paid_at AT TIME ZONE $3, 'YYYY-MM-DD') AS day, COALESCE(sum(amount - refund_amount), 0)::int AS revenue, count(*)::int AS payments
     FROM payments WHERE status IN ('paid','partially_refunded','refunded','refund_pending') AND paid_at >= $1 AND paid_at < $2
     GROUP BY 1 ORDER BY 1`,
    [fromUtc, toUtc, tz()]
  );
  const { rows: byMethod } = await query(
    `SELECT CASE WHEN provider IN ('razorpay','mock') THEN 'Online · ' || COALESCE(method, 'other') ELSE provider END AS method,
            COALESCE(sum(amount - refund_amount), 0)::int AS revenue, count(*)::int AS payments
     FROM payments WHERE status IN ('paid','partially_refunded','refunded','refund_pending') AND paid_at >= $1 AND paid_at < $2
     GROUP BY 1 ORDER BY 2 DESC`,
    [fromUtc, toUtc]
  );
  const { rows: byHour } = await query(
    `SELECT EXTRACT(HOUR FROM start_at AT TIME ZONE $3)::int AS hour, count(*)::int AS bookings
     FROM bookings WHERE status = 'confirmed' AND start_at >= $1 AND start_at < $2 GROUP BY 1 ORDER BY 1`,
    [fromUtc, toUtc, tz()]
  );
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push({ date: d, revenue: byDay.find((x) => x.day === d)?.revenue || 0 });
  return {
    from, to,
    totals: { gross: totals.gross, refunds: totals.refunds, net: totals.gross - totals.refunds, payments: totals.payments,
      bookings: bk.confirmed, cancelled: bk.cancelled, hours: Math.round(bk.hours * 10) / 10, bowlingMachine: bk.bowling },
    byFacility: byFacility.map((f) => ({ ...f, hours: Math.round(f.hours * 10) / 10 })),
    byDay: days,
    byMethod,
    byHour,
  };
}

adminRouter.get('/reports', async (req, res) => {
  const { from, to } = rangeFromQuery({ from: req.query.from || addDays(todayInZone(tz()), -29), to: req.query.to || todayInZone(tz()) });
  res.json(await buildReport(from, to));
});

adminRouter.get('/reports/bookings.csv', async (req, res) => {
  const { fromUtc, toUtc, from, to } = rangeFromQuery({ from: req.query.from || addDays(todayInZone(tz()), -29), to: req.query.to || todayInZone(tz()) });
  const { rows } = await query(`${BOOKING_SELECT} WHERE b.start_at >= $1 AND b.start_at < $2 AND b.status <> 'expired' ORDER BY b.start_at`, [fromUtc, toUtc]);
  const esc = (x) => {
    const s = x === null || x === undefined ? '' : String(x);
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s; // prevent CSV formula injection
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const lines = [['Booking ID', 'Date', 'Start', 'End', 'Facility', 'Qty', 'Assigned', 'Customer', 'Phone', 'Email', 'Bowling machine', 'Total (INR)', 'Refund (INR)', 'Status', 'Payment', 'Source'].join(',')];
  for (const r of rows.map(adminBookingView)) {
    lines.push([r.ref, r.date, hm(r.startMinute), hm(r.endMinute), r.facility.name, r.quantity, r.resource.name, r.customer.name, r.customer.phone, r.customer.email,
      r.bowlingMachine ? 'Yes' : 'No', (r.amounts.total / 100).toFixed(2), (r.amounts.refund / 100).toFixed(2), r.status, r.paymentStatus, r.source].map(esc).join(','));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="bookings_${from}_to_${to}.csv"`);
  res.send(lines.join('\n'));
});

// ───────────────────────────────────────────── settings & audit

adminRouter.get('/settings', async (req, res) => res.json(await getSettings()));

adminRouter.put('/settings/club', async (req, res) => {
  const b = req.body || {};
  const value = {
    name: v.str(b.name, 'Club name', { min: 2, max: 80 }),
    tagline: v.str(b.tagline, 'Tagline', { max: 140 }),
    address: v.str(b.address, 'Address', { max: 300 }),
    city: v.str(b.city, 'City', { max: 80 }),
    phone: v.str(b.phone, 'Phone', { max: 30 }),
    email: v.str(b.email, 'Email', { max: 120 }),
    whatsapp: v.str(b.whatsapp, 'WhatsApp', { max: 20, pattern: /^\d*$/ }),
    map_url: b.map_url ? v.str(b.map_url, 'Map link', { max: 500, pattern: /^https:\/\/\S+$/ }) : '',
    hours_note: v.str(b.hours_note, 'Hours note', { max: 120 }),
  };
  await saveSetting('club', value);
  await audit({ actor: req.user, ip: req.ip, action: 'settings.club', entityType: 'settings', entityId: 'club', details: value });
  res.json(await getSettings());
});

adminRouter.put('/settings/booking_policy', async (req, res) => {
  const b = req.body || {};
  const ext = Array.isArray(b.extension_options) ? b.extension_options : [30, 60];
  const value = {
    hold_minutes: v.int(b.hold_minutes, 'Payment hold', { min: 3, max: 30 }),
    cancellation_cutoff_hours: v.int(b.cancellation_cutoff_hours, 'Cancellation cut-off', { min: 0, max: 168 }),
    refund_percent: v.int(b.refund_percent, 'Refund %', { min: 0, max: 100 }),
    extension_options: [...new Set(ext.map((x) => v.int(x, 'Extension option', { min: 5, max: 240 })))].sort((a, c) => a - c).slice(0, 4),
  };
  await saveSetting('booking_policy', value);
  await audit({ actor: req.user, ip: req.ip, action: 'settings.booking_policy', entityType: 'settings', entityId: 'booking_policy', details: value });
  res.json(await getSettings());
});

adminRouter.get('/audit', async (req, res) => {
  const limit = v.int(req.query.limit ?? 100, 'limit', { min: 1, max: 500 });
  const offset = v.int(req.query.offset ?? 0, 'offset', { min: 0 });
  const { rows } = await query(
    `SELECT a.*, u.name AS actor_name, u.email AS actor_email FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
     ORDER BY a.created_at DESC LIMIT ${limit} OFFSET ${offset}`
  );
  res.json({ logs: rows.map((a) => ({ id: a.id, action: a.action, actor: a.actor_name || a.actor_email || a.actor_role, role: a.actor_role, entityType: a.entity_type, entityId: a.entity_id, details: a.details, ip: a.ip, createdAt: a.created_at })) });
});

