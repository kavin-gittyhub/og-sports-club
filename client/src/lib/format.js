const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });

/** paise → "₹800" */
export const money = (paise) => {
  if (paise === null || paise === undefined) return '—';
  return paise % 100 === 0 ? inr.format(paise / 100) : inr2.format(paise / 100);
};

/** minute-of-day → "7:30 PM" */
export function fmtMin(min) {
  const m = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

export const fmtRange = (s, e) => `${fmtMin(s)} – ${fmtMin(e)}`;

/** "6:30 – 7:30 PM" when both share AM/PM, else full range */
export function fmtRangeShort(s, e) {
  const a = fmtMin(s);
  const b = fmtMin(e);
  return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -3)} – ${b}` : `${a} – ${b}`;
}

export function fmtDuration(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (m === 0) return `${h} hr${h > 1 ? 's' : ''}`;
  if (m === 30) return `${h}.5 hrs`;
  return `${h} hr ${m} min`;
}

const parse = (d) => {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd));
};

/** "Mon, 15 Sept" */
export const fmtDate = (d, opts = {}) =>
  parse(d).toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', ...opts });

export const fmtDateLong = (d) =>
  parse(d).toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

export const fmtDateTime = (iso) =>
  new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export function addDays(d, n) {
  const dt = parse(d);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

export const dayOfWeek = (d) => parse(d).getUTCDay();
export const dayNum = (d) => parse(d).getUTCDate();
export const monthShort = (d) => parse(d).toLocaleDateString('en-IN', { timeZone: 'UTC', month: 'short' });
export const weekdayShort = (d) => parse(d).toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'short' });

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function fmtDays(days) {
  if (!days || days.length === 0 || days.length === 7) return 'Every day';
  const s = [...days].sort().join(',');
  if (s === '1,2,3,4,5') return 'Mon – Fri';
  if (s === '0,6') return 'Sat & Sun';
  return [...days].sort().map((d) => DAY_NAMES[d]).join(', ');
}

/** "HH:MM" ↔ minutes (for <input type=time>) */
export const minToHHMM = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const hhmmToMin = (s) => {
  if (!s) return null;
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};

export const rupeesToPaise = (r) => Math.round(Number(r) * 100);
export const paiseToRupees = (p) => (p ?? 0) / 100;

export const STATUS_LABEL = {
  upcoming: 'Confirmed',
  confirmed: 'Confirmed',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  expired: 'Expired',
  pending_payment: 'Payment pending',
};

export const PAYMENT_LABEL = {
  unpaid: 'Unpaid',
  paid: 'Paid',
  pay_at_venue: 'Pay at venue',
  refund_pending: 'Refund pending',
  refunded: 'Refunded',
  partially_refunded: 'Partly refunded',
  created: 'Started',
  failed: 'Failed',
};
