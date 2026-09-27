// Shared admin helpers
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { fmtMin, fmtDuration } from '../../lib/format.js';

let facilitiesCache = null;
export function useAdminFacilities() {
  const [state, setState] = useState({ facilities: facilitiesCache, loading: !facilitiesCache, error: null });
  const load = async () => {
    try {
      const { facilities } = await api('/admin/facilities');
      facilitiesCache = facilities;
      setState({ facilities, loading: false, error: null });
    } catch (error) {
      setState((s) => ({ ...s, loading: false, error }));
    }
  };
  useEffect(() => { load(); }, []);
  return { ...state, reload: load };
}
export const invalidateFacilities = () => { facilitiesCache = null; };

export function TimeSelect({ value, onChange, from = 0, to = 1440, step = 15, id, includeEnd = false, ...rest }) {
  const opts = [];
  for (let m = from; includeEnd ? m <= to : m < to; m += step) opts.push(m);
  if (value !== null && value !== undefined && !opts.includes(value)) opts.push(value), opts.sort((a, b) => a - b);
  return (
    <select id={id} className="select" value={value ?? ''} onChange={(e) => onChange(Number(e.target.value))} {...rest}>
      {opts.map((m) => <option key={m} value={m}>{m === 1440 ? '12:00 AM (midnight)' : fmtMin(m)}</option>)}
    </select>
  );
}

export function DurationSelect({ value, onChange, min = 30, max = 300, step = 15 }) {
  const opts = [];
  for (let d = min; d <= max; d += step) opts.push(d);
  if (value && !opts.includes(value)) opts.push(value), opts.sort((a, b) => a - b);
  return (
    <select className="select" value={value ?? ''} onChange={(e) => onChange(Number(e.target.value))}>
      {opts.map((d) => <option key={d} value={d}>{fmtDuration(d)}</option>)}
    </select>
  );
}

export function RupeeInput({ value, onChange, ...rest }) {
  return (
    <div className="input-group">
      <span className="input-prefix">₹</span>
      <input className="input" inputMode="decimal" type="number" min="0" step="1" value={value} onChange={(e) => onChange(e.target.value)} {...rest} />
    </div>
  );
}

export function PageHead({ title, sub, children }) {
  return (
    <div className="admin-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="muted">{sub}</p>}
      </div>
      {children && <div className="row gap-sm wrap">{children}</div>}
    </div>
  );
}
