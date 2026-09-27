// Availability engine. Works on internal resources; only aggregated results reach customers.
import { config } from '../config.js';
import { zonedDateTimeToUtc, utcToZoned, addDays, dayOfWeek, todayInZone, diffDays } from '../lib/time.js';
import { getActiveResources, allowedDurations } from './facilities.js';

const CELL = 5; // minutes

// A booking/extension counts as occupying time if confirmed, or a payment hold that hasn't expired.
const LIVE_BOOKING = `(b.status = 'confirmed' OR (b.status = 'pending_payment' AND (b.hold_expires_at IS NULL OR b.hold_expires_at > now())))`;

/**
 * Load everything that occupies a facility's resources in [from, to).
 * @returns {{resources, busy: Map<resourceId, Array<{start:Date,end:Date,kind:'booked'|'blocked',bookingId?}>>, machine: Array}}
 */
export async function loadOccupancy(db, fg, from, to, { excludeBookingId = null } = {}) {
  const resources = await getActiveResources(fg.id, { db });
  const busy = new Map(resources.map((r) => [r.id, []]));
  const machine = [];

  // Every net/court held by a live booking (one booking may hold several units).
  const { rows: units } = await db.query(
    `SELECT u.resource_id, u.start_at, u.end_at, b.id, b.bowling_machine FROM booking_units u
     JOIN bookings b ON b.id = u.booking_id
     WHERE b.facility_group_id = $1 AND u.active AND ${LIVE_BOOKING}
       AND u.start_at < $3 AND u.end_at > $2 AND ($4::uuid IS NULL OR b.id <> $4::uuid)`,
    [fg.id, from, to, excludeBookingId]
  );
  const machineSeen = new Set();
  for (const b of units) {
    busy.get(b.resource_id)?.push({ start: new Date(b.start_at), end: new Date(b.end_at), kind: 'booked', bookingId: b.id });
    // The bowling machine is one per booking, however many nets that booking holds.
    if (b.bowling_machine && !machineSeen.has(b.id)) {
      machineSeen.add(b.id);
      machine.push({ start: new Date(b.start_at), end: new Date(b.end_at), bookingId: b.id });
    }
  }

  const { rows: exts } = await db.query(
    `SELECT e.resource_id, e.start_at, e.end_at, e.booking_id, e.batch_id, b.bowling_machine FROM booking_extensions e
     JOIN bookings b ON b.id = e.booking_id
     WHERE b.facility_group_id = $1 AND e.status = 'pending_payment' AND e.hold_expires_at > now()
       AND e.start_at < $3 AND e.end_at > $2 AND ($4::uuid IS NULL OR e.booking_id <> $4::uuid)`,
    [fg.id, from, to, excludeBookingId]
  );
  for (const e of exts) {
    busy.get(e.resource_id)?.push({ start: new Date(e.start_at), end: new Date(e.end_at), kind: 'booked', bookingId: e.booking_id });
    if (e.bowling_machine && !machineSeen.has(e.batch_id)) {
      machineSeen.add(e.batch_id);
      machine.push({ start: new Date(e.start_at), end: new Date(e.end_at), bookingId: e.booking_id });
    }
  }

  const addBlock = (resourceId, start, end) => {
    const targets = resourceId ? [resourceId] : resources.map((r) => r.id);
    for (const id of targets) busy.get(id)?.push({ start, end, kind: 'blocked' });
  };

  const { rows: blocks } = await db.query(
    `SELECT resource_id, start_at, end_at FROM blocked_slots
     WHERE facility_group_id = $1 AND start_at < $3 AND end_at > $2`,
    [fg.id, from, to]
  );
  for (const bl of blocks) addBlock(bl.resource_id, new Date(bl.start_at), new Date(bl.end_at));

  const { rows: recurring } = await db.query(
    'SELECT * FROM recurring_blocks WHERE facility_group_id = $1 AND is_active',
    [fg.id]
  );
  if (recurring.length) {
    const tz = config.timezone;
    const firstDate = addDays(utcToZoned(from, tz).date, -1);
    const lastDate = utcToZoned(to, tz).date;
    for (let d = firstDate; d <= lastDate; d = addDays(d, 1)) {
      const dow = dayOfWeek(d);
      for (const rb of recurring) {
        if (!rb.days_of_week.includes(dow)) continue;
        if (rb.valid_from && d < rb.valid_from) continue;
        if (rb.valid_until && d > rb.valid_until) continue;
        const s = zonedDateTimeToUtc(d, rb.start_minute, tz);
        const e = zonedDateTimeToUtc(d, rb.end_minute, tz);
        if (s < to && e > from) addBlock(rb.resource_id, s, e);
      }
    }
  }
  return { resources, busy, machine };
}

const overlaps = (a, b) => a.start < b.end && a.end > b.start;

export function isResourceFree(occ, resourceId, start, end) {
  return !(occ.busy.get(resourceId) || []).some((iv) => overlaps(iv, { start, end }));
}

/**
 * Choose a free resource for [start, end). Best-fit: prefer the resource whose neighbouring
 * bookings are closest, so gaps stay usable for other customers.
 */
export function pickResource(occ, start, end, { preferId = null } = {}) {
  const free = occ.resources.filter((r) => isResourceFree(occ, r.id, start, end));
  if (!free.length) return null;
  if (preferId && free.some((r) => r.id === preferId)) return free.find((r) => r.id === preferId);
  const score = (r) => {
    let gap = 0;
    const ivs = occ.busy.get(r.id) || [];
    const before = ivs.filter((iv) => iv.end <= start).reduce((m, iv) => Math.max(m, iv.end.getTime()), -Infinity);
    const after = ivs.filter((iv) => iv.start >= end).reduce((m, iv) => Math.min(m, iv.start.getTime()), Infinity);
    gap += Number.isFinite(before) ? (start - before) / 60000 : 10000;
    gap += Number.isFinite(after) ? (after - end) / 60000 : 10000;
    return gap;
  };
  return free.sort((a, b) => score(a) - score(b) || a.sort_order - b.sort_order || a.id - b.id)[0];
}

/** Choose `count` different free units for [start, end), or null if not enough are free. */
export function pickResources(occ, start, end, count, { prefer = [] } = {}) {
  const chosen = [];
  const remaining = { ...occ, resources: [...occ.resources] };
  for (const id of prefer) {
    const r = remaining.resources.find((x) => x.id === id);
    if (r && isResourceFree(occ, r.id, start, end) && chosen.length < count) {
      chosen.push(r);
      remaining.resources = remaining.resources.filter((x) => x.id !== r.id);
    }
  }
  while (chosen.length < count) {
    const r = pickResource(remaining, start, end);
    if (!r) return null;
    chosen.push(r);
    remaining.resources = remaining.resources.filter((x) => x.id !== r.id);
  }
  return chosen;
}

export function freeUnitCount(occ, start, end) {
  return occ.resources.filter((r) => isResourceFree(occ, r.id, start, end)).length;
}

export function machineAvailable(occ, fg, start, end) {
  if (!fg.supports_bowling_machine || fg.bowling_machine_units <= 0) return false;
  // Worst-case concurrency across the window: count overlaps at each boundary.
  const relevant = occ.machine.filter((m) => overlaps(m, { start, end }));
  if (relevant.length < fg.bowling_machine_units) return true;
  const points = [start, ...relevant.map((m) => m.start).filter((t) => t > start && t < end)];
  return points.every((t) => relevant.filter((m) => m.start <= t && m.end > t).length < fg.bowling_machine_units);
}

/**
 * Customer-facing day grid. For each possible start time returns a status and the longest
 * continuous duration available on any single internal resource — no resource identities.
 */
export async function getDayAvailability(db, fg, date, now = new Date()) {
  const tz = config.timezone;
  const durations = allowedDurations(fg);
  const today = todayInZone(tz, now);
  const daysAhead = diffDays(today, date);
  const base = {
    date,
    openMinute: fg.open_minute,
    closeMinute: fg.close_minute,
    slotIntervalMin: fg.slot_interval_min,
    durations,
    slots: [],
  };
  if (daysAhead < 0) return { ...base, closedReason: 'This date is in the past.' };
  if (daysAhead > fg.advance_booking_days) {
    return { ...base, closedReason: `Bookings open ${fg.advance_booking_days} days in advance.` };
  }

  const open = fg.open_minute;
  const close = fg.close_minute;
  const nCells = Math.ceil((close - open) / CELL);
  const boundaries = [];
  for (let i = 0; i <= nCells; i++) boundaries.push(zonedDateTimeToUtc(date, Math.min(open + i * CELL, close), tz));

  const occ = await loadOccupancy(db, fg, boundaries[0], boundaries[nCells]);
  // state[r][i]: 0 free, 1 booked, 2 blocked
  const state = occ.resources.map((r) => {
    const cells = new Uint8Array(nCells);
    for (const iv of occ.busy.get(r.id)) {
      for (let i = 0; i < nCells; i++) {
        if (iv.start < boundaries[i + 1] && iv.end > boundaries[i]) {
          const val = iv.kind === 'blocked' ? 2 : 1;
          if (val > cells[i]) cells[i] = val;
        }
      }
    }
    return cells;
  });
  // run[r][i]: consecutive free cells starting at i
  const runs = state.map((cells) => {
    const run = new Uint16Array(nCells + 1);
    for (let i = nCells - 1; i >= 0; i--) run[i] = cells[i] === 0 ? run[i + 1] + 1 : 0;
    return run;
  });

  const minDur = durations[0] ?? fg.min_duration_min;
  const earliest = new Date(now.getTime() + fg.min_lead_minutes * 60000);
  const firstStart = Math.ceil(open / fg.slot_interval_min) * fg.slot_interval_min;
  for (let m = firstStart; m + minDur <= close; m += fg.slot_interval_min) {
    const i = (m - open) / CELL;
    const startAt = boundaries[i];
    let status;
    let maxFree = 0;
    let freeRuns = [];
    if (startAt < earliest) {
      status = 'past';
    } else {
      // Longest continuous free time on each unit from this start (anonymous, longest first).
      freeRuns = runs.map((run) => Math.min(run[i] * CELL, close - m)).filter((x) => x >= minDur).sort((a, b) => b - a);
      maxFree = Math.min(Math.max(0, ...runs.map((run) => run[i])) * CELL, close - m);
      if (maxFree >= minDur) status = 'available';
      else if (state.length && state.every((cells) => cells[i] === 2)) status = 'blocked';
      else if (!state.length) status = 'blocked';
      else status = 'booked';
    }
    base.slots.push({ minute: m, status, maxDuration: status === 'available' ? maxFree : 0, runs: status === 'available' ? freeRuns : [] });
  }
  if (!occ.resources.length) base.closedReason = 'Temporarily unavailable.';
  return base;
}
