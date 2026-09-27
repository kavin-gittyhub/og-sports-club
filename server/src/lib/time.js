// Time-zone helpers with zero dependencies (Intl-based, DST-safe).
// Dates travel as 'YYYY-MM-DD' strings in club local time; times as minutes-of-day (0..1440).

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const fmtCache = new Map();

function formatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    }));
  }
  return fmtCache.get(tz);
}

function parts(date, tz) {
  const out = {};
  for (const p of formatter(tz).formatToParts(date)) out[p.type] = p.value;
  return out;
}

/** Offset (minutes) of `tz` from UTC at instant `date`. IST → 330. */
export function tzOffsetMinutes(date, tz) {
  const p = parts(date, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

export function isValidDateStr(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Local club date + minute-of-day → UTC Date. */
export function zonedDateTimeToUtc(dateStr, minuteOfDay, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, 0, minuteOfDay);
  let guess = naive - tzOffsetMinutes(new Date(naive), tz) * 60000;
  const off2 = tzOffsetMinutes(new Date(guess), tz);
  guess = naive - off2 * 60000;
  return new Date(guess);
}

/** UTC instant → { date:'YYYY-MM-DD', minute, dow } in club local time. */
export function utcToZoned(date, tz) {
  const p = parts(date instanceof Date ? date : new Date(date), tz);
  const dateStr = `${p.year}-${p.month}-${p.day}`;
  return { date: dateStr, minute: (+p.hour % 24) * 60 + +p.minute, dow: dayOfWeek(dateStr) };
}

export function todayInZone(tz, now = new Date()) {
  return utcToZoned(now, tz).date;
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export function diffDays(a, b) {
  const pa = Date.UTC(...a.split('-').map((v, i) => (i === 1 ? +v - 1 : +v)));
  const pb = Date.UTC(...b.split('-').map((v, i) => (i === 1 ? +v - 1 : +v)));
  return Math.round((pb - pa) / 86400000);
}

/** 0 = Sunday … 6 = Saturday */
export function dayOfWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function formatMinute(min) {
  const m = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

export function formatDateLong(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  });
}
