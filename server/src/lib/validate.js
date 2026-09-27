// Small, explicit input validators — every request body is checked before use.
import { badRequest } from './errors.js';
import { isValidDateStr } from './time.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const v = {
  int(value, name, { min = -Infinity, max = Infinity, optional = false } = {}) {
    if (value === undefined || value === null || value === '') {
      if (optional) return undefined;
      throw badRequest(`${name} is required`, 'VALIDATION');
    }
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${name} must be a whole number between ${min} and ${max}`, 'VALIDATION');
    return n;
  },
  str(value, name, { max = 500, min = 0, optional = false, pattern } = {}) {
    if (value === undefined || value === null || value === '') {
      if (optional) return undefined;
      if (min === 0) return '';
      throw badRequest(`${name} is required`, 'VALIDATION');
    }
    if (typeof value !== 'string') throw badRequest(`${name} must be text`, 'VALIDATION');
    const s = value.trim();
    if (s.length < min || s.length > max) throw badRequest(`${name} must be ${min}–${max} characters`, 'VALIDATION');
    if (pattern && !pattern.test(s)) throw badRequest(`${name} is not valid`, 'VALIDATION');
    return s;
  },
  bool(value, name, { optional = false } = {}) {
    if (value === undefined || value === null) {
      if (optional) return undefined;
      return false;
    }
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    throw badRequest(`${name} must be true or false`, 'VALIDATION');
  },
  date(value, name, { optional = false } = {}) {
    if ((value === undefined || value === null || value === '') && optional) return undefined;
    if (!isValidDateStr(value)) throw badRequest(`${name} must be a date (YYYY-MM-DD)`, 'VALIDATION');
    return value;
  },
  uuid(value, name) {
    if (typeof value !== 'string' || !UUID_RE.test(value)) throw badRequest(`${name} is not valid`, 'VALIDATION');
    return value;
  },
  oneOf(value, name, options, { optional = false } = {}) {
    if ((value === undefined || value === null || value === '') && optional) return undefined;
    if (!options.includes(value)) throw badRequest(`${name} must be one of: ${options.join(', ')}`, 'VALIDATION');
    return value;
  },
  days(value, name) {
    if (!Array.isArray(value) || value.length === 0) throw badRequest(`${name}: choose at least one day`, 'VALIDATION');
    const out = [...new Set(value.map((d) => v.int(d, name, { min: 0, max: 6 })))].sort();
    return out;
  },
  isoInstant(value, name) {
    const d = new Date(value);
    if (typeof value !== 'string' || Number.isNaN(d.getTime())) throw badRequest(`${name} must be a date-time`, 'VALIDATION');
    return d;
  },
};

export const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);
