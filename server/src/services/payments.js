// Payments: Razorpay (UPI, cards, netbanking, wallets) with server-side verification,
// webhooks and refunds. A "mock" provider exists for local development only.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { query, tx, lockFacility } from '../db.js';
import { badRequest, conflict, notFound, HttpError } from '../lib/errors.js';
import { getFacilityById } from './facilities.js';
import { loadOccupancy, isResourceFree, pickResources, machineAvailable } from './availability.js';
import { getBookingUnits } from './bookings.js';
import { getSettings } from './settings.js';
import { audit } from './audit.js';
import { formatMinute, utcToZoned, formatDateLong } from '../lib/time.js';

const RZP_API = 'https://api.razorpay.com/v1';

async function razorpay(method, path, body) {
  const auth = Buffer.from(`${config.razorpayKeyId}:${config.razorpayKeySecret}`).toString('base64');
  const res = await fetch(`${RZP_API}${path}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.description || `Razorpay error ${res.status}`;
    const err = new HttpError(502, `Payment provider error: ${msg}`, 'PAYMENT_PROVIDER');
    err.provider = data;
    throw err;
  }
  return data;
}

function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export function verifyCheckoutSignature(orderId, paymentId, signature) {
  const expected = crypto.createHmac('sha256', config.razorpayKeySecret).update(`${orderId}|${paymentId}`).digest('hex');
  return safeEqualHex(expected, signature);
}

export function verifyWebhookSignature(rawBody, signature) {
  if (!config.razorpayWebhookSecret) return false;
  const expected = crypto.createHmac('sha256', config.razorpayWebhookSecret).update(rawBody).digest('hex');
  return safeEqualHex(expected, signature);
}

const isMock = () => config.paymentProvider === 'mock' && !config.isProduction;

/** Create (or reuse) a provider order for a booking or an extension and return checkout params. */
export async function startCheckout({ booking, extension = null, user }) {
  const amount = extension ? extension.amount : booking.total_amount;
  if (amount <= 0) throw badRequest('Nothing to pay for this booking.');

  // Reuse an open order for the same target (e.g. the customer closed the payment window and retried).
  const { rows: [open] } = await query(
    `SELECT * FROM payments WHERE booking_id = $1 AND extension_id IS NOT DISTINCT FROM $2
       AND status IN ('created','failed') AND amount = $3 AND provider = $4 ORDER BY created_at DESC LIMIT 1`,
    [booking.id, extension?.id || null, amount, isMock() ? 'mock' : 'razorpay']
  );
  let orderId = open?.provider_order_id;
  if (!orderId) {
    if (isMock()) {
      orderId = `mock_order_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;
    } else {
      const order = await razorpay('POST', '/orders', {
        amount,
        currency: 'INR',
        receipt: extension ? `${booking.booking_ref}-X${extension.minutes}` : booking.booking_ref,
        notes: { booking_id: booking.id, booking_ref: booking.booking_ref, extension_id: extension?.id || '' },
      });
      orderId = order.id;
    }
    await query(
      `INSERT INTO payments (booking_id, extension_id, user_id, provider, provider_order_id, amount, status)
       VALUES ($1,$2,$3,$4,$5,$6,'created')`,
      [booking.id, extension?.id || null, user.id, isMock() ? 'mock' : 'razorpay', orderId, amount]
    );
  }
  const settings = await getSettings();
  const fg = await getFacilityById(booking.facility_group_id);
  const s = utcToZoned(extension ? extension.start_at : booking.start_at, config.timezone);
  const e = utcToZoned(extension ? extension.end_at : booking.end_at, config.timezone);
  return {
    provider: isMock() ? 'mock' : 'razorpay',
    keyId: isMock() ? null : config.razorpayKeyId,
    orderId,
    amount,
    currency: 'INR',
    name: settings.club.name,
    description: `${extension ? 'Extension · ' : ''}${fg.name}${booking.quantity > 1 ? ` × ${booking.quantity} ${fg.unit_label || 'unit'}s` : ''} · ${formatDateLong(s.date)} · ${formatMinute(s.minute)}–${formatMinute(e.minute)}`,
    prefill: { name: user.name || '', email: user.email || '', contact: user.phone || '' },
    bookingId: booking.id,
    extensionId: extension?.id || null,
  };
}

/**
 * Mark an order paid and confirm what it pays for. Idempotent — safe to call from both the
 * checkout callback and the webhook. If the slot was lost while paying, the payment is refunded.
 */
export async function finalizePaidOrder({ orderId, paymentId, method = null, raw = null, amount = null, source }) {
  const result = await tx(async (client) => {
    const { rows: [pre] } = await client.query(
      `SELECT p.id, b.facility_group_id FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE p.provider_order_id = $1`,
      [orderId]
    );
    if (!pre) throw notFound('Payment not found.');
    await lockFacility(client, pre.facility_group_id);
    const { rows: [pay] } = await client.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [pre.id]);
    if (['paid', 'refund_pending', 'refunded', 'partially_refunded'].includes(pay.status)) {
      return { bookingId: pay.booking_id, already: true, refund: 0, paymentRowId: pay.id };
    }
    if (amount !== null && amount !== pay.amount) {
      throw new HttpError(400, 'Payment amount mismatch.', 'AMOUNT_MISMATCH');
    }
    await client.query(
      `UPDATE payments SET status = 'paid', provider_payment_id = $2, method = $3, raw = $4, paid_at = now(), updated_at = now() WHERE id = $1`,
      [pay.id, paymentId, method, raw ? JSON.stringify(raw) : null]
    );
    const { rows: [b] } = await client.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [pay.booking_id]);
    const fg = await getFacilityById(b.facility_group_id, { db: client });
    let refund = 0;
    let outcome = 'confirmed';

    if (pay.extension_id) {
      const { rows: [first] } = await client.query('SELECT * FROM booking_extensions WHERE id = $1', [pay.extension_id]);
      const { rows: exts } = await client.query('SELECT * FROM booking_extensions WHERE batch_id = $1 FOR UPDATE', [first.batch_id]);
      const extStart = new Date(first.start_at);
      const extEnd = new Date(first.end_at);
      const stillAdjacent = b.status === 'confirmed' && new Date(b.end_at).getTime() === extStart.getTime();
      let ok = false;
      if (stillAdjacent && exts.every((e) => ['pending_payment', 'expired'].includes(e.status))) {
        const occ = await loadOccupancy(client, fg, extStart, extEnd, { excludeBookingId: b.id });
        const units = await getBookingUnits(client, b.id);
        ok = units.every((u) => isResourceFree(occ, u.resource_id, extStart, extEnd))
          && (!b.bowling_machine || machineAvailable(occ, fg, extStart, extEnd));
      }
      const extAmount = pay.amount;
      if (ok) {
        await client.query(`UPDATE booking_extensions SET status = 'confirmed', updated_at = now() WHERE batch_id = $1`, [first.batch_id]);
        // Moving end_at extends every unit via the trigger (and the overlap guard re-checks).
        await client.query(
          `UPDATE bookings SET end_at = $2, extension_amount = extension_amount + $3, total_amount = total_amount + $3, updated_at = now() WHERE id = $1`,
          [b.id, first.end_at, extAmount]
        );
        outcome = 'extended';
      } else {
        await client.query(`UPDATE booking_extensions SET status = 'cancelled', updated_at = now() WHERE batch_id = $1`, [first.batch_id]);
        refund = pay.amount;
        outcome = 'extension_lost';
      }
    } else if (b.status === 'pending_payment') {
      await client.query(
        `UPDATE bookings SET status = 'confirmed', payment_status = 'paid', hold_expires_at = NULL, updated_at = now() WHERE id = $1`,
        [b.id]
      );
    } else if (b.status === 'expired') {
      // Hold ran out while paying — re-reserve the same number of units if we still can.
      const start = new Date(b.start_at);
      const end = new Date(b.end_at);
      const occ = await loadOccupancy(client, fg, start, end, { excludeBookingId: b.id });
      const units = await getBookingUnits(client, b.id);
      const targets = pickResources(occ, start, end, units.length, { prefer: units.map((u) => u.resource_id) });
      const machineOk = !b.bowling_machine || machineAvailable(occ, fg, start, end);
      if (targets && machineOk && start > new Date()) {
        const keep = new Set(targets.map((t) => t.id));
        const fresh = targets.filter((t) => !units.some((u) => u.resource_id === t.id));
        for (const u of units) {
          if (!keep.has(u.resource_id)) await client.query('UPDATE booking_units SET resource_id = $2 WHERE id = $1', [u.id, fresh.shift().id]);
        }
        await client.query(
          `UPDATE bookings SET status = 'confirmed', payment_status = 'paid', resource_id = $2, hold_expires_at = NULL, updated_at = now() WHERE id = $1`,
          [b.id, targets[0].id]
        );
      } else {
        refund = pay.amount;
        outcome = 'slot_lost';
        await client.query(
          `UPDATE bookings SET status = 'cancelled', payment_status = 'refund_pending', refund_amount = $2,
             cancel_reason = 'Slot was no longer available when payment completed — automatic refund', cancelled_at = now(), updated_at = now()
           WHERE id = $1`,
          [b.id, pay.amount]
        );
      }
    } else if (b.status === 'cancelled') {
      refund = pay.amount;
      outcome = 'booking_cancelled';
      await client.query(
        `UPDATE bookings SET payment_status = 'refund_pending', refund_amount = refund_amount + $2, updated_at = now() WHERE id = $1`,
        [b.id, pay.amount]
      );
    }
    await audit({ db: client, action: `payment.${outcome}`, entityType: 'booking', entityId: b.id,
      details: { ref: b.booking_ref, orderId, paymentId, amount: pay.amount, via: source } });
    return { bookingId: b.id, refund, paymentRowId: pay.id, outcome };
  });

  if (result.refund > 0) await refundPayment({ paymentRowId: result.paymentRowId, amount: result.refund, reason: result.outcome });
  return result;
}

export async function markPaymentFailed({ orderId, reason, raw }) {
  await query(
    `UPDATE payments SET status = 'failed', failure_reason = $2, raw = COALESCE($3, raw), updated_at = now()
     WHERE provider_order_id = $1 AND status = 'created'`,
    [orderId, reason || 'Payment failed', raw ? JSON.stringify(raw) : null]
  );
}

/** Refund (fully or partly) one payment row via its provider. */
export async function refundPayment({ paymentRowId, amount, reason, actor = null }) {
  const { rows: [pay] } = await query('SELECT * FROM payments WHERE id = $1', [paymentRowId]);
  if (!pay) throw notFound('Payment not found.');
  const refundable = pay.amount - pay.refund_amount;
  const amt = Math.min(amount, refundable);
  if (amt <= 0) return { refunded: 0 };

  let providerRefundId = null;
  let ok = true;
  let error = null;
  if (pay.provider === 'razorpay') {
    try {
      const r = await razorpay('POST', `/payments/${pay.provider_payment_id}/refund`, {
        amount: amt, speed: 'normal', notes: { reason: String(reason || '').slice(0, 250) },
      });
      providerRefundId = r.id;
    } catch (err) {
      ok = false;
      error = err.message;
      console.error('[payments] refund failed', err.message);
    }
  }
  // mock / offline methods: record the refund (cash refunds are handed over at the desk).
  const newRefund = pay.refund_amount + (ok ? amt : 0);
  const status = !ok ? 'refund_pending' : newRefund >= pay.amount ? 'refunded' : 'partially_refunded';
  await query(
    `UPDATE payments SET refund_amount = $2, status = $3, provider_refund_id = COALESCE($4, provider_refund_id),
       failure_reason = COALESCE($5, failure_reason), updated_at = now() WHERE id = $1`,
    [pay.id, newRefund, status, providerRefundId, error]
  );
  await syncBookingPaymentStatus(pay.booking_id);
  await audit({ actor, action: ok ? 'payment.refund' : 'payment.refund_failed', entityType: 'payment', entityId: pay.id,
    details: { amount: amt, reason, error } });
  return { refunded: ok ? amt : 0, error };
}

/** Refund up to `amount` across a booking's paid payments (newest first). */
export async function refundBooking({ bookingId, amount, reason, actor }) {
  let remaining = amount;
  const { rows } = await query(
    `SELECT id, amount - refund_amount AS refundable FROM payments
     WHERE booking_id = $1 AND status IN ('paid','partially_refunded','refund_pending') AND amount > refund_amount
     ORDER BY created_at DESC`,
    [bookingId]
  );
  const errors = [];
  for (const p of rows) {
    if (remaining <= 0) break;
    const r = await refundPayment({ paymentRowId: p.id, amount: Math.min(remaining, p.refundable), reason, actor });
    remaining -= r.refunded;
    if (r.error) errors.push(r.error);
  }
  await syncBookingPaymentStatus(bookingId);
  return { refunded: amount - remaining, errors };
}

async function syncBookingPaymentStatus(bookingId) {
  const { rows: [agg] } = await query(
    `SELECT COALESCE(sum(amount) FILTER (WHERE status <> 'created' AND status <> 'failed'), 0)::int AS paid,
            COALESCE(sum(refund_amount), 0)::int AS refunded,
            bool_or(status = 'refund_pending') AS pending
     FROM payments WHERE booking_id = $1`,
    [bookingId]
  );
  const { rows: [b] } = await query('SELECT refund_amount, payment_status FROM bookings WHERE id = $1', [bookingId]);
  if (!b || agg.paid === 0) return;
  let status = 'paid';
  if (agg.pending || (b.refund_amount > agg.refunded)) status = 'refund_pending';
  else if (agg.refunded >= agg.paid) status = 'refunded';
  else if (agg.refunded > 0) status = 'partially_refunded';
  await query('UPDATE bookings SET payment_status = $2, updated_at = now() WHERE id = $1', [bookingId, status]);
}

/** Checkout callback verification (client → server after Razorpay success). */
export async function verifyCheckout({ user, orderId, paymentId, signature, mock = false }) {
  const { rows: [pay] } = await query('SELECT * FROM payments WHERE provider_order_id = $1', [orderId]);
  if (!pay || pay.user_id !== user.id) throw notFound('Payment not found.');

  if (pay.provider === 'mock') {
    if (!isMock() || !mock) throw badRequest('Invalid payment.');
    return finalizePaidOrder({ orderId, paymentId: `mock_pay_${crypto.randomUUID().slice(0, 12)}`, method: 'upi', source: 'mock' });
  }
  if (!paymentId || !signature || !verifyCheckoutSignature(orderId, paymentId, signature)) {
    await audit({ actor: user, action: 'payment.signature_invalid', entityType: 'payment', entityId: pay.id, details: { orderId } });
    throw badRequest('Payment could not be verified. If money was deducted it will be confirmed or refunded automatically.', 'SIGNATURE_INVALID');
  }
  // Double-check with Razorpay: correct order, amount and a successful state.
  const p = await razorpay('GET', `/payments/${encodeURIComponent(paymentId)}`);
  if (p.order_id !== orderId) throw badRequest('Payment does not match this order.', 'ORDER_MISMATCH');
  if (p.status === 'authorized') {
    await razorpay('POST', `/payments/${encodeURIComponent(paymentId)}/capture`, { amount: p.amount, currency: p.currency });
  } else if (p.status !== 'captured') {
    throw conflict('Payment is not complete yet. We will confirm automatically once it succeeds.', 'PAYMENT_PENDING');
  }
  return finalizePaidOrder({ orderId, paymentId, method: p.method, raw: { id: p.id, method: p.method, vpa: p.vpa, bank: p.bank }, amount: p.amount, source: 'checkout' });
}

/** Razorpay webhook handler. `rawBody` must be the exact bytes received. */
export async function handleWebhook({ rawBody, signature, eventId }) {
  if (!verifyWebhookSignature(rawBody, signature)) throw new HttpError(400, 'Invalid signature', 'SIGNATURE_INVALID');
  const payload = JSON.parse(rawBody.toString('utf8'));
  const id = eventId || `${payload.event}:${payload.payload?.payment?.entity?.id || payload.payload?.refund?.entity?.id || payload.created_at}`;
  const { rowCount } = await query(
    `INSERT INTO webhook_events (id, provider, event) VALUES ($1, 'razorpay', $2) ON CONFLICT (id) DO NOTHING`,
    [id, payload.event]
  );
  if (!rowCount) return { duplicate: true };

  const payment = payload.payload?.payment?.entity;
  try {
    switch (payload.event) {
      case 'payment.captured':
      case 'order.paid': {
        if (!payment?.order_id) break;
        const { rows: [known] } = await query('SELECT 1 FROM payments WHERE provider_order_id = $1', [payment.order_id]);
        if (!known) break;
        await finalizePaidOrder({
          orderId: payment.order_id, paymentId: payment.id, method: payment.method,
          raw: { id: payment.id, method: payment.method, vpa: payment.vpa, bank: payment.bank }, amount: payment.amount, source: 'webhook',
        });
        break;
      }
      case 'payment.authorized': {
        // Auto-capture is recommended in the Razorpay dashboard; capture here as a fallback.
        if (payment?.order_id) {
          const { rows: [known] } = await query('SELECT amount FROM payments WHERE provider_order_id = $1', [payment.order_id]);
          if (known && known.amount === payment.amount) {
            await razorpay('POST', `/payments/${payment.id}/capture`, { amount: payment.amount, currency: payment.currency }).catch(() => {});
          }
        }
        break;
      }
      case 'payment.failed':
        if (payment?.order_id) await markPaymentFailed({ orderId: payment.order_id, reason: payment.error_description, raw: { id: payment.id } });
        break;
      case 'refund.processed': {
        const refund = payload.payload?.refund?.entity;
        if (refund?.payment_id) {
          await query(`UPDATE payments SET provider_refund_id = COALESCE(provider_refund_id, $2), updated_at = now() WHERE provider_payment_id = $1`, [refund.payment_id, refund.id]);
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    // Let Razorpay retry on unexpected failures.
    await query('DELETE FROM webhook_events WHERE id = $1', [id]);
    throw err;
  }
  return { ok: true };
}
