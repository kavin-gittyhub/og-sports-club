import express from 'express';
import { query } from '../db.js';
import { v, isUuid } from '../lib/validate.js';
import { badRequest, notFound } from '../lib/errors.js';
import { rateLimit } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { getFacilityBySlug, getFacilityById } from '../services/facilities.js';
import {
  createBooking, cancelBooking, customerBookingView, getExtensionOptions, createExtension,
} from '../services/bookings.js';
import { startCheckout, verifyCheckout, markPaymentFailed, refundBooking } from '../services/payments.js';
import { getSettings } from '../services/settings.js';
import { payAtVenue } from '../config.js';

export const customerRouter = express.Router();
customerRouter.use(requireAuth);

const bookingLimiter = rateLimit({ windowMs: 10 * 60_000, max: 30, key: (req) => req.user?.id || req.ip });

const meView = (u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role });

customerRouter.get('/me', (req, res) => res.json({ user: meView(req.user) }));

customerRouter.patch('/me', async (req, res) => {
  const name = v.str(req.body?.name, 'Name', { max: 80, optional: true });
  const phone = v.str(req.body?.phone, 'Phone', { max: 20, optional: true, pattern: /^[+\d][\d\s-]{6,18}$/ });
  const { rows: [u] } = await query(
    'UPDATE users SET name = COALESCE($2, name), phone = COALESCE($3, phone), updated_at = now() WHERE id = $1 RETURNING *',
    [req.user.id, name ?? null, phone ?? null]
  );
  res.json({ user: meView(u) });
});

async function loadOwnBooking(req) {
  if (!isUuid(req.params.id)) throw notFound('Booking not found.');
  const { rows: [b] } = await query('SELECT * FROM bookings WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!b) throw notFound('Booking not found.');
  return b;
}

customerRouter.get('/bookings', async (req, res) => {
  const settings = await getSettings();
  const { rows } = await query(
    `SELECT b.*, g.slug, g.name AS g_name, g.sport, g.unit_label FROM bookings b JOIN facility_groups g ON g.id = b.facility_group_id
     WHERE b.user_id = $1 AND NOT (b.status = 'expired' AND b.payment_status = 'unpaid')
     ORDER BY b.start_at DESC LIMIT 200`,
    [req.user.id]
  );
  res.json({
    bookings: rows.map((b) => customerBookingView(b, { slug: b.slug, name: b.g_name, sport: b.sport, unit_label: b.unit_label }, settings)),
  });
});

customerRouter.get('/bookings/:id', async (req, res) => {
  const b = await loadOwnBooking(req);
  const fg = await getFacilityById(b.facility_group_id);
  res.json({ booking: customerBookingView(b, fg, await getSettings()) });
});

customerRouter.post('/bookings', bookingLimiter, async (req, res) => {
  const body = req.body || {};
  const fg = await getFacilityBySlug(v.str(body.facility, 'facility', { max: 60 }));
  const bowlingMachine = v.bool(body.bowlingMachine, 'bowlingMachine');
  if (bowlingMachine && !fg.supports_bowling_machine) {
    throw badRequest('The bowling machine is only available with Cricket Nets.', 'ADDON_NOT_ALLOWED');
  }
  // Let customers add a phone number during checkout (needed for UPI prefill & contact).
  const phone = v.str(body.phone, 'Phone', { max: 20, optional: true, pattern: /^[+\d][\d\s-]{6,18}$/ });
  if (phone && phone !== req.user.phone) {
    req.user = (await query('UPDATE users SET phone = $2, updated_at = now() WHERE id = $1 RETURNING *', [req.user.id, phone])).rows[0];
  }
  // Stop one account from tying up many slots with unpaid holds.
  const { rows: [{ holds }] } = await query(
    `SELECT count(*)::int AS holds FROM bookings WHERE user_id = $1 AND status = 'pending_payment' AND hold_expires_at > now()`,
    [req.user.id]
  );
  if (holds >= 3) throw badRequest('You have unpaid bookings waiting. Please complete or cancel them first.', 'TOO_MANY_HOLDS');
  const booking = await createBooking({
    fg,
    user: req.user,
    actor: req.user,
    date: v.date(body.date, 'date'),
    startMinute: v.int(body.startMinute, 'startMinute', { min: 0, max: 1439 }),
    durationMin: v.int(body.durationMin, 'durationMin', { min: 5, max: 1440 }),
    bowlingMachine,
    quantity: v.int(body.quantity ?? 1, 'quantity', { min: 1, max: 50 }),
    payAtVenue: payAtVenue(),
    ip: req.ip,
  });
  if (payAtVenue()) {
    return res.status(201).json({ booking: customerBookingView(booking, fg, await getSettings()), checkout: null });
  }
  let checkout;
  try {
    checkout = await startCheckout({ booking, user: req.user });
  } catch (err) {
    // Release the hold straight away if the payment order could not be created.
    await query(`UPDATE bookings SET status = 'cancelled', cancel_reason = 'Payment could not be started', updated_at = now() WHERE id = $1`, [booking.id]);
    throw err;
  }
  res.status(201).json({ booking: customerBookingView(booking, fg, await getSettings()), checkout });
});

customerRouter.post('/bookings/:id/pay', bookingLimiter, async (req, res) => {
  const b = await loadOwnBooking(req);
  if (payAtVenue()) throw badRequest('Online payment is not available. Please pay at the club.', 'PAY_AT_VENUE');
  if (b.status !== 'pending_payment' || (b.hold_expires_at && new Date(b.hold_expires_at) < new Date())) {
    throw badRequest('This booking can no longer be paid for. Please make a new booking.', 'HOLD_EXPIRED');
  }
  res.json({ checkout: await startCheckout({ booking: b, user: req.user }) });
});

customerRouter.post('/bookings/:id/cancel', async (req, res) => {
  const b = await loadOwnBooking(req);
  const { booking, refundAmount } = await cancelBooking({
    bookingId: b.id, actor: req.user, reason: v.str(req.body?.reason, 'reason', { max: 300, optional: true }) || 'Cancelled by customer', ip: req.ip,
  });
  let refund = { refunded: 0 };
  if (refundAmount > 0) refund = await refundBooking({ bookingId: b.id, amount: refundAmount, reason: 'Customer cancellation', actor: req.user });
  const fresh = (await query('SELECT * FROM bookings WHERE id = $1', [booking.id])).rows[0];
  const fg = await getFacilityById(fresh.facility_group_id);
  res.json({ booking: customerBookingView(fresh, fg, await getSettings()), refund: { amount: refundAmount, processed: refund.refunded } });
});

customerRouter.get('/bookings/:id/extensions', async (req, res) => {
  const b = await loadOwnBooking(req);
  res.json({ options: await getExtensionOptions({ bookingId: b.id, user: req.user }) });
});

customerRouter.post('/bookings/:id/extensions', bookingLimiter, async (req, res) => {
  const b = await loadOwnBooking(req);
  const minutes = v.int(req.body?.minutes, 'minutes', { min: 5, max: 240 });
  if (payAtVenue()) {
    const { booking } = await createExtension({ bookingId: b.id, user: req.user, minutes, confirmNow: true, ip: req.ip });
    const fg = await getFacilityById(booking.facility_group_id);
    return res.status(201).json({ checkout: null, outcome: 'extended', booking: customerBookingView(booking, fg, await getSettings()) });
  }
  const { booking, extension } = await createExtension({ bookingId: b.id, user: req.user, minutes, ip: req.ip });
  res.status(201).json({ checkout: await startCheckout({ booking, extension, user: req.user }) });
});

customerRouter.post('/payments/verify', bookingLimiter, async (req, res) => {
  const body = req.body || {};
  const result = await verifyCheckout({
    user: req.user,
    orderId: v.str(body.orderId, 'orderId', { max: 80, min: 1 }),
    paymentId: v.str(body.paymentId, 'paymentId', { max: 80, optional: true }),
    signature: v.str(body.signature, 'signature', { max: 200, optional: true }),
    mock: v.bool(body.mock, 'mock'),
  });
  const b = (await query('SELECT * FROM bookings WHERE id = $1', [result.bookingId])).rows[0];
  const fg = await getFacilityById(b.facility_group_id);
  res.json({ outcome: result.outcome || 'confirmed', booking: customerBookingView(b, fg, await getSettings()) });
});

customerRouter.post('/payments/failed', async (req, res) => {
  const orderId = v.str(req.body?.orderId, 'orderId', { max: 80, min: 1 });
  const { rows: [p] } = await query('SELECT user_id FROM payments WHERE provider_order_id = $1', [orderId]);
  if (!p || p.user_id !== req.user.id) throw notFound('Payment not found.');
  await markPaymentFailed({ orderId, reason: v.str(req.body?.reason, 'reason', { max: 300, optional: true }) || 'Cancelled by customer' });
  res.json({ ok: true });
});
