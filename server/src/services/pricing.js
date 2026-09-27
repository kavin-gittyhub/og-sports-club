// Server-side price calculation. The client NEVER supplies an amount.
import { badRequest } from '../lib/errors.js';
import { dayOfWeek, addDays, formatMinute } from '../lib/time.js';

const SLICE = 5; // minutes

function ruleMatches(rule, dateStr, dow, minute) {
  if (rule.days_of_week && rule.days_of_week.length && !rule.days_of_week.includes(dow)) return false;
  if (rule.valid_from && dateStr < rule.valid_from) return false;
  if (rule.valid_until && dateStr > rule.valid_until) return false;
  return minute >= rule.start_minute && minute < rule.end_minute;
}

function rateFor(rules, dateStr, minute) {
  // Handle bookings that run past midnight (minute >= 1440)
  const d = minute >= 1440 ? addDays(dateStr, Math.floor(minute / 1440)) : dateStr;
  const m = minute % 1440;
  const dow = dayOfWeek(d);
  let best = null;
  for (const r of rules) {
    if (!ruleMatches(r, d, dow, m)) continue;
    if (!best || r.priority > best.priority || (r.priority === best.priority && r.id < best.id)) best = r;
  }
  return best;
}

/**
 * Price a slot. Each 5-minute slice is charged at the highest-priority matching rule's hourly rate.
 * Returns amounts in paise, rounded to the nearest rupee.
 */
export function computePrice({ fg, rules, date, startMinute, durationMin, bowlingMachine = false, quantity = 1 }) {
  if (bowlingMachine && !fg.supports_bowling_machine) {
    throw badRequest('The bowling machine is only available with Cricket Nets.', 'ADDON_NOT_ALLOWED');
  }
  let base = 0;
  const lines = new Map();
  for (let m = startMinute; m < startMinute + durationMin; m += SLICE) {
    const rule = rateFor(rules, date, m);
    if (!rule) throw badRequest(`No price is set for ${formatMinute(m)}. Please contact the club.`, 'NO_PRICE');
    base += (rule.price_per_hour * SLICE) / 60;
    const line = lines.get(rule.id) || { label: rule.label, pricePerHour: rule.price_per_hour, minutes: 0 };
    line.minutes += SLICE;
    lines.set(rule.id, line);
  }
  const unitPrice = Math.round(base / 100) * 100;
  base = unitPrice * quantity; // each net/court is charged separately
  // One bowling machine per booking (limited by how many machines the club owns).
  const addon = bowlingMachine ? Math.round((fg.bowling_machine_price_per_hour * durationMin) / 60 / 100) * 100 : 0;
  return {
    base,
    addon,
    total: base + addon,
    unitPrice,
    quantity,
    breakdown: [...lines.values()].map((l) => ({ ...l, quantity })),
  };
}

/** Cheapest hourly rate for a facility (for “from ₹X/hr” on cards). */
export function fromPrice(rules) {
  if (!rules.length) return null;
  return Math.min(...rules.map((r) => r.price_per_hour));
}
