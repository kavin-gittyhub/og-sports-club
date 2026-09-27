import { useEffect, useState } from 'react';
import { api, download } from '../../lib/api.js';
import { Link } from '../../lib/router.jsx';
import { useSession } from '../../lib/auth.jsx';
import { money, fmtDate, fmtRange, addDays } from '../../lib/format.js';
import { Icon } from '../../components/Icons.jsx';
import { Button, ErrorBox, Field, StatusBadge, PaymentBadge, Skeleton, Empty, useAsync } from '../../components/ui.jsx';
import { PageHead, useAdminFacilities } from './shared.jsx';
import { BookingDrawer } from './BookingDrawer.jsx';

export default function BookingsList() {
  const { config } = useSession();
  const today = config?.today;
  const { facilities } = useAdminFacilities();
  const [filters, setFilters] = useState({ from: today, to: today ? addDays(today, 13) : '', facility: '', status: '', q: '' });
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState(null);
  useEffect(() => { if (today && !filters.from) setFilters((f) => ({ ...f, from: today, to: addDays(today, 13) })); }, [today]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setTimeout(() => setFilters((f) => ({ ...f, q })), 300); return () => clearTimeout(t); }, [q]);

  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  const { data, loading, error, reload } = useAsync(() => (filters.from ? api(`/admin/bookings?${qs}`) : Promise.resolve(null)), [qs]);
  const set = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const presets = [
    ['Today', today, today],
    ['Next 7 days', today, today && addDays(today, 6)],
    ['Last 30 days', today && addDays(today, -29), today],
  ];

  return (
    <>
      <PageHead title="Bookings" sub={data ? `${data.total} booking${data.total === 1 ? '' : 's'}` : ' '}>
        <Button variant="outline" size="sm" icon="download" onClick={() => download(`/admin/reports/bookings.csv?from=${filters.from}&to=${filters.to}`, `bookings_${filters.from}_${filters.to}.csv`)}>Export CSV</Button>
        <Link to="/admin/bookings/new" className="btn btn-primary btn-sm"><Icon name="plus" size={18} />New booking</Link>
      </PageHead>
      <div className="row gap-sm wrap" style={{ marginBottom: 12 }}>
        {presets.map(([label, from, to]) => (
          <button key={label} className={`fac-tab ${filters.from === from && filters.to === to ? 'is-active' : ''}`} onClick={() => setFilters((f) => ({ ...f, from, to }))}>{label}</button>
        ))}
      </div>
      <div className="toolbar">
        <Field label="From"><input className="input" type="date" value={filters.from || ''} onChange={set('from')} /></Field>
        <Field label="To"><input className="input" type="date" value={filters.to || ''} onChange={set('to')} /></Field>
        <Field label="Facility">
          <select className="select" value={filters.facility} onChange={set('facility')}>
            <option value="">All facilities</option>
            {facilities?.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <select className="select" value={filters.status} onChange={set('status')}>
            <option value="">Active & cancelled</option>
            <option value="confirmed">Confirmed</option>
            <option value="pending_payment">Awaiting payment</option>
            <option value="cancelled">Cancelled</option>
            <option value="expired">Expired holds</option>
          </select>
        </Field>
        <Field label="Search" className="grow-field">
          <input className="input" type="search" placeholder="Name, phone, email or booking ID" value={q} onChange={(e) => setQ(e.target.value)} />
        </Field>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr><th>When</th><th>Facility</th><th>Resource</th><th>Customer</th><th>Status</th><th>Payment</th><th className="num">Amount</th></tr>
          </thead>
          <tbody>
            {loading && !data && Array.from({ length: 6 }, (_, i) => <tr key={i}><td colSpan={7}><Skeleton h={18} /></td></tr>)}
            {data?.bookings.map((b) => (
              <tr key={b.id} className="clickable" onClick={() => setOpenId(b.id)}>
                <td><div className="cell-strong">{fmtDate(b.date)}</div><div className="cell-sub">{fmtRange(b.startMinute, b.endMinute)}</div></td>
                <td>{b.facility.name}{b.bowlingMachine && <div className="cell-sub"><Icon name="zap" size={12} /> Bowling machine</div>}</td>
                <td><span className="resource-tag">{b.resource.name}</span></td>
                <td><div className="cell-strong">{b.customer.name || '—'}</div><div className="cell-sub">{b.customer.phone || b.customer.email}</div></td>
                <td><StatusBadge status={b.displayStatus} /></td>
                <td><PaymentBadge status={b.paymentStatus} /></td>
                <td className="num"><div className="cell-strong">{money(b.amounts.total)}</div><div className="cell-sub mono">{b.ref}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.bookings.length === 0 && <Empty icon="search" title="No bookings match">Try a different date range or filter.</Empty>}
      </div>
      <BookingDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => reload({ silent: true })} />
    </>
  );
}
