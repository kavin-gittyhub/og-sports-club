import { query } from '../db.js';
import { notFound } from '../lib/errors.js';

// Every facility row carries unit_count = number of active nets/courts (never their names).
const FG_SELECT = `SELECT g.*, (SELECT count(*)::int FROM resources r WHERE r.facility_group_id = g.id AND r.is_active) AS unit_count
  FROM facility_groups g`;

export async function listFacilities({ includeInactive = false, db = { query } } = {}) {
  const { rows } = await db.query(
    `${FG_SELECT} ${includeInactive ? '' : 'WHERE g.is_active'} ORDER BY g.sort_order, g.id`
  );
  return rows;
}

export async function getFacilityBySlug(slug, { includeInactive = false, db = { query } } = {}) {
  const { rows } = await db.query(
    `${FG_SELECT} WHERE g.slug = $1 ${includeInactive ? '' : 'AND g.is_active'}`,
    [slug]
  );
  if (!rows[0]) throw notFound('That activity is not available.');
  return rows[0];
}

export async function getFacilityById(id, { db = { query } } = {}) {
  const { rows } = await db.query(`${FG_SELECT} WHERE g.id = $1`, [id]);
  if (!rows[0]) throw notFound('Facility not found.');
  return rows[0];
}

export async function getPricingRules(facilityGroupId, { db = { query } } = {}) {
  const { rows } = await db.query(
    'SELECT * FROM pricing WHERE facility_group_id = $1 AND is_active ORDER BY priority DESC, id',
    [facilityGroupId]
  );
  return rows;
}

export async function getActiveResources(facilityGroupId, { db = { query } } = {}) {
  const { rows } = await db.query(
    'SELECT id, name, sort_order FROM resources WHERE facility_group_id = $1 AND is_active ORDER BY sort_order, id',
    [facilityGroupId]
  );
  return rows;
}

/** Valid booking durations (minutes) for a facility. */
export function allowedDurations(fg) {
  const out = [];
  const span = fg.close_minute - fg.open_minute;
  for (let d = fg.min_duration_min; d <= fg.max_duration_min && d <= span; d += fg.duration_step_min) out.push(d);
  return out;
}

/** Most units (nets/courts) one booking may hold. */
export function maxQuantity(fg) {
  const units = fg.unit_count ?? 1;
  return Math.max(1, fg.max_units_per_booking > 0 ? Math.min(units, fg.max_units_per_booking) : units);
}

/** What customers may see about a facility — never internal resources. */
export function publicFacility(fg, { fromPrice } = {}) {
  return {
    slug: fg.slug,
    name: fg.name,
    tagline: fg.tagline,
    description: fg.description,
    sport: fg.sport,
    imageUrl: fg.image_url,
    features: fg.features || [],
    openMinute: fg.open_minute,
    closeMinute: fg.close_minute,
    slotIntervalMin: fg.slot_interval_min,
    durations: allowedDurations(fg),
    maxQuantity: maxQuantity(fg),
    unitLabel: fg.unit_label || 'unit',
    advanceBookingDays: fg.advance_booking_days,
    bowlingMachine: fg.supports_bowling_machine
      ? { available: fg.bowling_machine_units > 0, pricePerHour: fg.bowling_machine_price_per_hour }
      : null,
    fromPricePerHour: fromPrice ?? null,
  };
}
