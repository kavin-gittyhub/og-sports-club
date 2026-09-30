// Booking lifecycle: create (customer/admin), edit, cancel, extend. All mutations run inside a
// transaction holding the facility's advisory lock; EXCLUDE constraints are the final guard.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { query, tx, lockFacility } from '../db.js';
import { badRequest, conflict, notFound, isOverlapViolation } from '../lib/errors.js';
import { zonedDateTimeToUtc, utcToZoned, todayInZone, diffDays, formatMinute } from '../lib/time.js';
import { allowedDurations, getFacilityById, getPricingRules, getActiveResources, maxQuantity } from './facilities.js';
import { computePrice } from './pricing.js';
import { loadOccupancy, pickResources, isResourceFree, machineAvailable, freeUnitCount } from './availability.js';
import { getSettings } from './settings.js';
import { audit } from './audit.js';

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newBookingRef() {
  const bytes = crypto.randomBytes(6);
  let s = '';
  for (const b of bytes) s += REF_ALPHABET[b % REF_ALPHABET.length];
  return `OG-${s}`;
}

export async function sweepExpiredHolds(db = { query }) {
  const a = await db.query(
    `UPDATE bookings SET status = 'expired', updated_at = now()
     WHERE status = 'pending_payment' AND hold_expires_at IS NOT NULL AND hold_expires_at < now()`
  );
  const b = await db.query(
    `UPDATE booking_extensions SET status = 'expired', updated_at = now()
     WHERE status = 'pending_payment' AND hold_expires_at < now()`
  );
  return (a.rowCount || 0) + (b.rowCount || 0);
}

/** Validate a requested slot against the facility's configured rules. */
export function validateTiming(fg, { date, startMinute, durationMin }, { admin = false, now = new Date() } = {}) {
  const tz = config.timezone;
  const endMinute = startMinute + durationMin;
  if (admin) {
    if (startMinute % 5 || durationMin % 5 || durationMin < 5) throw badRequest('Times must be in 5-minute steps.', 'INVALID_TIME');
    if (endMinute > 1440) throw badRequest('A booking must end by midnight.', 'INVALID_TIME');
  } else {
    const daysAhead = diffDays(todayInZone(tz, now), date);
    if (daysAhead < 0) throw badRequest('That date has already passed.', 'INVALID_DATE');
    if (daysAhead > fg.advance_booking_days) throw badRequest(`You can book up to ${fg.advance_booking_days} days ahead.`, 'INVALID_DATE');
    if (startMinute % fg.slot_interval_min !== 0) throw badRequest(`Start times are every ${fg.slot_interval_min} minutes.`, 'INVALID_TIME');
    if (!allowedDurations(fg).includes(durationMin)) throw badRequest('Please choose one of the available durations.', 'INVALID_DURATION');
    if (startMinute < fg.open_minute || endMinute > fg.close_minute) {
      throw badRequest(`${fg.name} is open ${formatMinute(fg.open_minute)} – ${formatMinute(fg.close_minute)}.`, 'OUTSIDE_HOURS');
    }
  }
  const startAt = zonedDateTimeToUtc(date, startMinute, tz);
  const endAt = zonedDateTimeToUtc(date, endMinute, tz);
  if (!admin && startAt.getTime() < now.getTime() + fg.min_lead_minutes * 60000) {
    throw badRequest('That start time has already passed. Please choose a later time.', 'INVALID_TIME');
  }
  return { startAt, endAt, endMinute };
}

function checkQuantity(fg, quantity) {
  const max = maxQuantity(fg);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > max) {
    throw badRequest(max === 1 ? 'Only one can be booked at a time.' : `You can book 1 to ${max} ${fg.unit_label || 'unit'}s at once.`, 'INVALID_QUANTITY');
  }
  return quantity;
}

/** Price + availability check without holding anything (used by the summary step). */
export async function quote({ fg, date, startMinute, durationMin, bowlingMachine, quantity = 1 }) {
  checkQuantity(fg, quantity);
  const { startAt, endAt } = validateTiming(fg, { date, startMinute, durationMin });
  const rules = await getPricingRules(fg.id);
  const price = computePrice({ fg, rules, date, startMinute, durationMin, bowlingMachine, quantity });
  const occ = await loadOccupancy({ query }, fg, startAt, endAt);
  const freeUnits = freeUnitCount(occ, startAt, endAt);
  const machineOk = fg.supports_bowling_machine ? machineAvailable(occ, fg, startAt, endAt) : false;
  return {
    available: freeUnits >= quantity && (!bowlingMachine || machineOk),
    slotAvailable: freeUnits >= quantity,
    freeUnits: Math.min(freeUnits, maxQuantity(fg)),
    bowlingMachineAvailable: fg.supports_bowling_machine ? machineOk : null,
    price,
  };
}

async function insertBooking(client, fields) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const { rows } = await client.query(
        `INSERT INTO bookings (booking_ref, user_id, facility_group_id, resource_id, start_at, end_at, bowling_machine,
           base_amount, addon_amount, total_amount, status, payment_status, source, hold_expires_at,
           customer_name, customer_phone, notes, created_by, quantity)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
        [newBookingRef(), fields.userId, fields.fgId, fields.resourceIds[0], fields.startAt, fields.endAt, fields.bowlingMachine,
          fields.base, fields.addon, fields.total, fields.status, fields.paymentStatus, fields.source, fields.holdExpiresAt,
          fields.customerName, fields.customerPhone, fields.notes, fields.createdBy, fields.resourceIds.length]
      );
      const booking = rows[0];
      for (const rid of fields.resourceIds) {
        await client.query(
          `INSERT INTO booking_units (booking_id, resource_id, start_at, end_at, active) VALUES ($1,$2,$3,$4,$5)`,
          [booking.id, rid, fields.startAt, fields.endAt, ['pending_payment', 'confirmed'].includes(fields.status)]
        );
      }
      return booking;
    } catch (err) {
      if (err.code === '23505' && /booking_ref/.test(err.constraint || '')) continue;
      throw err;
    }
  }
  throw new Error('Could not allocate a booking reference');
}

/** Units (nets/courts) held by a booking, in a stable order. */
export async function getBookingUnits(db, bookingId) {
  const { rows } = await db.query(
    `SELECT u.id, u.resource_id, r.name FROM booking_units u JOIN resources r ON r.id = u.resource_id
     WHERE u.booking_id = $1 ORDER BY r.sort_order, r.id`,
    [bookingId]
  );
  return rows;
}

/**
 * Create a booking for `quantity` units. Customers get a short payment hold; admins can confirm directly.
 * @param {object} p
 * @param {object} p.fg facility group row
 * @param {object} p.user the customer the booking belongs to
 * @param {object} p.actor who performs the action (customer or admin)
 * @param {object} [p.admin] admin-only options: { resourceIds, paymentMode, amountOverride, notes }
 */
export async function createBooking({ fg, user, actor, date, startMinute, durationMin, bowlingMachine = false, quantity = 1, admin = null, payAtVenue = false, ip }) {
  if (bowlingMachine && !fg.supports_bowling_machine) {
    throw badRequest('The bowling machine is only available with Cricket Nets.', 'ADDON_NOT_ALLOWED');
  }
  checkQuantity(fg, quantity);
  const settings = await getSettings();
  const isAdmin = Boolean(admin);
  const { startAt, endAt } = validateTiming(fg, { date, startMinute, durationMin }, { admin: isAdmin });
  const rules = await getPricingRules(fg.id);
  const price = computePrice({ fg, rules, date, startMinute, durationMin, bowlingMachine, quantity });
  const noun = fg.unit_label || 'unit';

  try {
    return await tx(async (client) => {
      await lockFacility(client, fg.id);
      await sweepExpiredHolds(client);
      const occ = await loadOccupancy(client, fg, startAt, endAt);

      let chosen;
      const wanted = isAdmin && Array.isArray(admin.resourceIds) ? [...new Set(admin.resourceIds)] : [];
      if (wanted.length) {
        if (wanted.length !== quantity) throw badRequest(`Pick exactly ${quantity} ${noun}${quantity > 1 ? 's' : ''}, or choose Auto.`);
        chosen = wanted.map((id) => {
          const r = occ.resources.find((x) => x.id === id);
          if (!r) throw badRequest('That resource does not belong to this facility or is inactive.');
          if (!isResourceFree(occ, r.id, startAt, endAt)) throw conflict(`${r.name} is already booked or blocked at that time.`, 'SLOT_TAKEN');
          return r;
        });
      } else {
        chosen = pickResources(occ, startAt, endAt, quantity);
      }
      if (!chosen) {
        const free = freeUnitCount(occ, startAt, endAt);
        throw conflict(
          free > 0 && quantity > 1
            ? `Only ${free} ${noun}${free > 1 ? 's are' : ' is'} free at that time. Choose fewer or another time.`
            : 'Sorry — that time was just taken. Please choose another time.',
          'SLOT_TAKEN', { freeUnits: free }
        );
      }
      if (bowlingMachine && !machineAvailable(occ, fg, startAt, endAt)) {
        throw conflict('The bowling machine is already booked for that time. Choose “No” or another time.', 'MACHINE_TAKEN');
      }

      let status = 'pending_payment';
      let paymentStatus = 'unpaid';
      let holdExpiresAt = new Date(Date.now() + settings.booking_policy.hold_minutes * 60000);
      let total = price.total;
      if (isAdmin) {
        holdExpiresAt = null;
        status = 'confirmed';
        paymentStatus = admin.paymentMode === 'pay_at_venue' ? 'pay_at_venue' : 'paid';
        if (Number.isInteger(admin.amountOverride)) total = admin.amountOverride;
      } else if (payAtVenue) {
        // Online payment is off: confirm now, the customer pays at the club.
        holdExpiresAt = null;
        status = 'confirmed';
        paymentStatus = 'pay_at_venue';
      }

      const booking = await insertBooking(client, {
        userId: user.id, fgId: fg.id, resourceIds: chosen.map((r) => r.id), startAt, endAt, bowlingMachine,
        base: isAdmin && Number.isInteger(admin.amountOverride) ? Math.max(0, total - price.addon) : price.base,
        addon: price.addon, total, status, paymentStatus, source: isAdmin ? 'admin' : 'online', holdExpiresAt,
        customerName: user.name, customerPhone: user.phone, notes: admin?.notes || null, createdBy: actor.id,
      });

      if (isAdmin && paymentStatus === 'paid' && total > 0) {
        await client.query(
          `INSERT INTO payments (booking_id, user_id, provider, amount, status, method, paid_at)
           VALUES ($1,$2,$3,$4,'paid',$5, now())`,
          [booking.id, user.id, admin.paymentMode, total, admin.paymentMode === 'cash' ? 'cash' : admin.paymentMode === 'card_offline' ? 'card' : 'upi']
        );
      }
      await audit({
        db: client, actor, ip, action: isAdmin ? 'booking.admin_create' : 'booking.create', entityType: 'booking', entityId: booking.id,
        details: { ref: booking.booking_ref, facility: fg.slug, units: chosen.map((r) => r.name), date, startMinute, durationMin, quantity, bowlingMachine, total },
      });
      return booking;
    });
  } catch (err) {
    if (isOverlapViolation(err)) throw conflict('Sorry — that time was just taken. Please choose another time.', 'SLOT_TAKEN');
    throw err;
  }
}

/**
 * Re-point a booking's units to free resources for [start, end) (keeping current ones where possible),
 * then let the caller update the booking row — the trigger re-activates units and the constraint re-checks.
 */
async function reassignUnits(client, booking, units, occ, start, end, { forceResourceIds = null } = {}) {
  let targets;
  if (forceResourceIds) {
    targets = forceResourceIds.map((id) => {
      const r = occ.resources.find((x) => x.id === id);
      if (!r) throw badRequest('Invalid resource for this facility.');
      if (!isResourceFree(occ, id, start, end)) throw conflict(`${r.name} is busy at that time.`, 'SLOT_TAKEN');
      return r;
    });
  } else {
    targets = pickResources(occ, start, end, units.length, { prefer: units.map((u) => u.resource_id) });
  }
  if (!targets) return null;
  // Deactivate first so swapping units between resources never trips the overlap guard mid-way.
  await client.query('UPDATE booking_units SET active = false WHERE booking_id = $1', [booking.id]);
  const keep = new Set(targets.map((t) => t.id));
  const freeTargets = targets.filter((t) => !units.some((u) => u.resource_id === t.id));
  for (const u of units) {
    if (keep.has(u.resource_id)) continue;
    const t = freeTargets.shift();
    await client.query('UPDATE booking_units SET resource_id = $2 WHERE id = $1', [u.id, t.id]);
  }
  return targets;
}

/** Admin edit: move/resize/reassign, change amounts or notes. */
export async function updateBooking({ bookingId, actor, changes, ip }) {
  try {
    return await tx(async (client) => {
      const { rows: [current] } = await client.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
      if (!current) throw notFound('Booking not found.');
      await lockFacility(client, current.facility_group_id);
      const { rows: [b] } = await client.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [bookingId]);
      const fg = await getFacilityById(b.facility_group_id, { db: client });
      const units = await getBookingUnits(client, b.id);
      const tz = config.timezone;
      const cur = utcToZoned(b.start_at, tz);
      const curDuration = Math.round((new Date(b.end_at) - new Date(b.start_at)) / 60000);

      const date = changes.date ?? cur.date;
      const startMinute = changes.startMinute ?? cur.minute;
      const durationMin = changes.durationMin ?? curDuration;
      const bowlingMachine = changes.bowlingMachine ?? b.bowling_machine;
      if (bowlingMachine && !fg.supports_bowling_machine) throw badRequest('Bowling machine is only for Cricket Nets.', 'ADDON_NOT_ALLOWED');
      const { startAt, endAt } = validateTiming(fg, { date, startMinute, durationMin }, { admin: true });

      let forceIds = null;
      if (changes.resourceIds?.length) forceIds = [...new Set(changes.resourceIds)];
      else if (changes.resourceId) forceIds = [changes.resourceId, ...units.slice(1).map((u) => u.resource_id).filter((id) => id !== changes.resourceId)];
      if (forceIds && forceIds.length !== units.length) throw badRequest(`This booking holds ${units.length} units — pick ${units.length}.`);

      const live = ['pending_payment', 'confirmed'].includes(b.status);
      let resourceIds = units.map((u) => u.resource_id);
      if (live) {
        await sweepExpiredHolds(client);
        const occ = await loadOccupancy(client, fg, startAt, endAt, { excludeBookingId: b.id });
        if (bowlingMachine && !machineAvailable(occ, fg, startAt, endAt)) throw conflict('Bowling machine is busy at that time.', 'MACHINE_TAKEN');
        const targets = await reassignUnits(client, b, units, occ, startAt, endAt, { forceResourceIds: forceIds });
        if (!targets) throw conflict('Not enough free units at the new time.', 'SLOT_TAKEN');
        resourceIds = targets.map((t) => t.id);
      } else if (forceIds) {
        await reassignUnits(client, b, units, { resources: (await getActiveResources(fg.id, { db: client })), busy: new Map() }, startAt, endAt, { forceResourceIds: forceIds });
        resourceIds = forceIds;
      }

      let { base_amount: base, addon_amount: addon, extension_amount: ext, total_amount: total } = b;
      if (changes.reprice) {
        const rules = await getPricingRules(fg.id, { db: client });
        const p = computePrice({ fg, rules, date, startMinute, durationMin, bowlingMachine, quantity: b.quantity });
        base = p.base; addon = p.addon; ext = 0; total = p.total;
      }
      if (Number.isInteger(changes.totalAmount)) {
        total = changes.totalAmount;
        base = Math.max(0, total - addon - ext);
      }

      // Updating start/end fires the trigger that syncs (and re-activates) every unit.
      const { rows: [updated] } = await client.query(
        `UPDATE bookings SET start_at = $2, end_at = $3, resource_id = $4, bowling_machine = $5,
           base_amount = $6, addon_amount = $7, extension_amount = $8, total_amount = $9,
           notes = COALESCE($10, notes), customer_name = COALESCE($11, customer_name), customer_phone = COALESCE($12, customer_phone),
           payment_status = COALESCE($13, payment_status), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [b.id, startAt, endAt, resourceIds[0], bowlingMachine, base, addon, ext, total,
          changes.notes ?? null, changes.customerName ?? null, changes.customerPhone ?? null, changes.paymentStatus ?? null]
      );
      await audit({ db: client, actor, ip, action: 'booking.admin_update', entityType: 'booking', entityId: b.id,
        details: { ref: b.booking_ref, before: { start: b.start_at, end: b.end_at, units: units.map((u) => u.name), total: b.total_amount }, changes } });
      return updated;
    });
  } catch (err) {
    if (isOverlapViolation(err)) throw conflict('That change would overlap another booking.', 'SLOT_TAKEN');
    throw err;
  }
}

/** Cancellation eligibility + refund for a customer. */
export function customerCancelPolicy(b, settings, now = new Date()) {
  const policy = settings.booking_policy;
  if (b.status === 'pending_payment') return { canCancel: true, refund: 0, reason: null };
  if (b.status !== 'confirmed') return { canCancel: false, refund: 0, reason: 'This booking is not active.' };
  const hoursLeft = (new Date(b.start_at) - now) / 3600000;
  if (hoursLeft < policy.cancellation_cutoff_hours) {
    return { canCancel: false, refund: 0, reason: `Bookings can be cancelled up to ${policy.cancellation_cutoff_hours} hours before start.` };
  }
  const paidOnline = b.payment_status === 'paid' ? b.total_amount : 0;
  const refund = Math.round((paidOnline * policy.refund_percent) / 100 / 100) * 100;
  return { canCancel: true, refund, reason: null };
}

/**
 * Cancel a booking. Returns { booking, refundAmount } — the caller triggers the provider refund.
 */
export async function cancelBooking({ bookingId, actor, isAdmin = false, reason = null, refundAmount: requestedRefund, ip }) {
  const settings = await getSettings();
  return tx(async (client) => {
    const { rows: [pre] } = await client.query('SELECT facility_group_id FROM bookings WHERE id = $1', [bookingId]);
    if (!pre) throw notFound('Booking not found.');
    await lockFacility(client, pre.facility_group_id);
    const { rows: [b] } = await client.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [bookingId]);
    if (!isAdmin && b.user_id !== actor.id) throw notFound('Booking not found.');
    if (!['pending_payment', 'confirmed'].includes(b.status)) throw badRequest('This booking is already cancelled or expired.', 'NOT_CANCELLABLE');

    let refund = 0;
    if (isAdmin) {
      const { rows: [{ paid }] } = await client.query(
        `SELECT COALESCE(sum(amount - refund_amount), 0)::int AS paid FROM payments WHERE booking_id = $1 AND status IN ('paid','partially_refunded')`,
        [b.id]
      );
      refund = requestedRefund === undefined ? paid : Math.min(Math.max(0, requestedRefund), paid);
    } else {
      const pol = customerCancelPolicy(b, settings);
      if (!pol.canCancel) throw badRequest(pol.reason, 'NOT_CANCELLABLE');
      refund = pol.refund;
    }

    const { rows: [updated] } = await client.query(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3,
         refund_amount = $4, payment_status = CASE WHEN $4 > 0 THEN 'refund_pending' ELSE payment_status END, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [b.id, actor.id, reason, refund]
    );
    await client.query(
      `UPDATE booking_extensions SET status = 'cancelled', updated_at = now() WHERE booking_id = $1 AND status = 'pending_payment'`,
      [b.id]
    );
    await audit({ db: client, actor, ip, action: isAdmin ? 'booking.admin_cancel' : 'booking.cancel', entityType: 'booking', entityId: b.id,
      details: { ref: b.booking_ref, refund, reason } });
    return { booking: updated, refundAmount: refund };
  });
}

// ─────────────────────────────────────────────────────────── extensions

async function extensionCheck(db, b, fg, minutes, rules) {
  const tz = config.timezone;
  const endLocal = utcToZoned(b.end_at, tz);
  const startLocal = utcToZoned(b.start_at, tz);
  const now = new Date();
  const base = { minutes, available: false, amount: 0 };
  if (b.status !== 'confirmed') return { ...base, reason: 'Only confirmed bookings can be extended.' };
  if (new Date(b.end_at) <= now) return { ...base, reason: 'This booking has already ended.' };
  const newEndMinute = (endLocal.date === startLocal.date ? endLocal.minute : 1440) + minutes;
  if (endLocal.date !== startLocal.date || newEndMinute > fg.close_minute) {
    return { ...base, reason: `${fg.name} closes at ${formatMinute(fg.close_minute)}.` };
  }
  const start = new Date(b.end_at);
  const end = new Date(start.getTime() + minutes * 60000);
  const occ = await loadOccupancy(db, fg, start, end, { excludeBookingId: b.id });
  // Every net/court in the booking must stay on the same unit for the extra time.
  const units = await getBookingUnits(db, b.id);
  if (!units.every((u) => isResourceFree(occ, u.resource_id, start, end))) {
    return { ...base, reason: units.length > 1 ? 'The next slot is already booked on one of your ' + (fg.unit_label || 'unit') + 's.' : 'The next slot is already booked.' };
  }
  if (b.bowling_machine && !machineAvailable(occ, fg, start, end)) return { ...base, reason: 'The bowling machine is booked right after you.' };
  const price = computePrice({ fg, rules, date: endLocal.date, startMinute: endLocal.minute, durationMin: minutes, bowlingMachine: b.bowling_machine, quantity: units.length });
  return { minutes, available: true, amount: price.total, start, end, newEndMinute, units, reason: null };
}

export async function getExtensionOptions({ bookingId, user }) {
  const { rows: [b] } = await query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
  if (!b || b.user_id !== user.id) throw notFound('Booking not found.');
  const fg = await getFacilityById(b.facility_group_id);
  const rules = await getPricingRules(fg.id);
  const settings = await getSettings();
  const opts = [];
  for (const m of settings.booking_policy.extension_options) {
    const r = await extensionCheck({ query }, b, fg, m, rules);
    opts.push({ minutes: m, available: r.available, amount: r.amount, newEndMinute: r.newEndMinute ?? null, reason: r.reason });
  }
  return opts;
}

export async function createExtension({ bookingId, user, minutes, confirmNow = false, ip }) {
  const settings = await getSettings();
  if (!settings.booking_policy.extension_options.includes(minutes)) throw badRequest('Choose a valid extension.', 'VALIDATION');
  try {
    return await tx(async (client) => {
      const { rows: [pre] } = await client.query('SELECT facility_group_id, user_id FROM bookings WHERE id = $1', [bookingId]);
      if (!pre || pre.user_id !== user.id) throw notFound('Booking not found.');
      await lockFacility(client, pre.facility_group_id);
      await sweepExpiredHolds(client);
      const { rows: [b] } = await client.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [bookingId]);
      const fg = await getFacilityById(b.facility_group_id, { db: client });
      const rules = await getPricingRules(fg.id, { db: client });
      // Replace any earlier unpaid extension attempt for this booking.
      await client.query(`UPDATE booking_extensions SET status = 'cancelled', updated_at = now() WHERE booking_id = $1 AND status = 'pending_payment'`, [b.id]);
      const check = await extensionCheck(client, b, fg, minutes, rules);
      if (!check.available) throw conflict(check.reason || 'That extension is not available.', 'EXTENSION_UNAVAILABLE');
      // One hold row per unit; the first row carries the amount and is what the payment points to.
      const batchId = crypto.randomUUID();
      let ext = null;
      for (const [i, u] of check.units.entries()) {
        const { rows: [row] } = await client.query(
          `INSERT INTO booking_extensions (booking_id, resource_id, start_at, end_at, minutes, amount, status, hold_expires_at, created_by, batch_id)
           VALUES ($1,$2,$3,$4,$5,$6,'pending_payment', now() + make_interval(mins => $7), $8, $9) RETURNING *`,
          [b.id, u.resource_id, check.start, check.end, minutes, i === 0 ? check.amount : 0, settings.booking_policy.hold_minutes, user.id, batchId]
        );
        if (i === 0) ext = row;
      }
      ext.amount = check.amount;
      if (confirmNow) {
        // Pay-at-venue mode: availability was checked under the facility lock above, so confirm straight away.
        // Moving end_at extends every unit via the trigger (and the overlap guard re-checks).
        await client.query(`UPDATE booking_extensions SET status = 'confirmed', updated_at = now() WHERE batch_id = $1`, [batchId]);
        const { rows: [updated] } = await client.query(
          `UPDATE bookings SET end_at = $2, extension_amount = extension_amount + $3, total_amount = total_amount + $3, updated_at = now()
           WHERE id = $1 RETURNING *`,
          [b.id, check.end, check.amount]
        );
        await audit({ db: client, actor: user, ip, action: 'booking.extended', entityType: 'booking', entityId: b.id,
          details: { ref: b.booking_ref, minutes, amount: check.amount, payment: 'pay_at_venue' } });
        return { booking: updated, extension: { ...ext, status: 'confirmed' } };
      }
      await audit({ db: client, actor: user, ip, action: 'booking.extension_requested', entityType: 'booking', entityId: b.id,
        details: { ref: b.booking_ref, minutes, amount: check.amount } });
      return { booking: b, extension: ext };
    });
  } catch (err) {
    if (isOverlapViolation(err)) throw conflict('The next slot was just taken.', 'EXTENSION_UNAVAILABLE');
    throw err;
  }
}

// ─────────────────────────────────────────────────────────── serialisation

export function displayStatus(b, now = new Date()) {
  if (b.status === 'cancelled') return 'cancelled';
  if (b.status === 'expired') return 'expired';
  if (b.status === 'pending_payment') return 'pending_payment';
  if (new Date(b.end_at) <= now) return 'completed';
  if (new Date(b.start_at) <= now) return 'in_progress';
  return 'upcoming';
}

/** Customer-safe view of a booking — NO internal resource information. */
export function customerBookingView(b, fg, settings) {
  const tz = config.timezone;
  const s = utcToZoned(b.start_at, tz);
  const e = utcToZoned(b.end_at, tz);
  const pol = customerCancelPolicy(b, settings);
  const ds = displayStatus(b);
  return {
    id: b.id,
    ref: b.booking_ref,
    facility: { slug: fg.slug, name: fg.name, sport: fg.sport, unitLabel: fg.unit_label || 'unit' },
    quantity: b.quantity || 1,
    date: s.date,
    startMinute: s.minute,
    endMinute: e.date === s.date ? e.minute : 1440,
    startAt: b.start_at,
    endAt: b.end_at,
    durationMin: Math.round((new Date(b.end_at) - new Date(b.start_at)) / 60000),
    bowlingMachine: b.bowling_machine,
    amounts: { base: b.base_amount, addon: b.addon_amount, extension: b.extension_amount, total: b.total_amount, refund: b.refund_amount },
    status: b.status,
    displayStatus: ds,
    paymentStatus: b.payment_status,
    holdExpiresAt: b.status === 'pending_payment' ? b.hold_expires_at : null,
    cancellation: { allowed: pol.canCancel && ds !== 'completed' && ds !== 'in_progress', refund: pol.refund, reason: pol.reason, cutoffHours: settings.booking_policy.cancellation_cutoff_hours },
    canExtend: b.status === 'confirmed' && new Date(b.end_at) > new Date(),
    cancelledAt: b.cancelled_at,
    createdAt: b.created_at,
  };
}

