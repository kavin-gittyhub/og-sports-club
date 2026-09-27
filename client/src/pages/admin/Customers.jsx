import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/auth.jsx';
import { money, fmtDate, fmtRange, fmtDateTime } from '../../lib/format.js';
import { Button, ErrorBox, Field, Modal, Spinner, StatusBadge, Badge, Empty, Skeleton, useAsync, useToast, useConfirm } from '../../components/ui.jsx';
import { PageHead } from './shared.jsx';
import { BookingDrawer } from './BookingDrawer.jsx';

function CustomerModal({ id, onClose, onChanged }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { me } = useSession();
  const { data, loading, error, reload } = useAsync(() => (id ? api(`/admin/customers/${id}`) : Promise.resolve(null)), [id]);
  const [openBooking, setOpenBooking] = useState(null);
  const c = data?.customer;
  const patch = async (body, msg) => {
    try { await api(`/admin/customers/${id}`, { method: 'PATCH', body }); toast.success(msg); reload({ silent: true }); onChanged(); } catch (e) { toast.error(e.message); }
  };
  const makeAdmin = async (on) => {
    if (on && !(await confirm({ title: `Give ${c.name || c.email} admin access?`, message: 'They will be able to see all bookings, customers and payments and change settings.', confirmText: 'Grant admin' }))) return;
    patch({ role: on ? 'admin' : 'customer' }, on ? 'Admin access granted' : 'Admin access removed');
  };
  const block = async (on) => {
    if (on && !(await confirm({ title: 'Suspend this customer?', message: 'They won’t be able to make new bookings. Existing bookings stay.', confirmText: 'Suspend', danger: true }))) return;
    patch({ isBlocked: on }, on ? 'Customer suspended' : 'Customer re-activated');
  };
  return (
    <Modal open={Boolean(id)} onClose={onClose} title={c?.name || 'Customer'} size="lg">
      <ErrorBox error={error} onRetry={reload} />
      {loading && !c && <div className="center-x"><Spinner /></div>}
      {c && (
        <>
          <div className="row gap-sm wrap">
            {c.role === 'admin' && <Badge tone="lime">Admin</Badge>}
            {c.isBlocked && <Badge tone="red">Suspended</Badge>}
            {c.isWalkIn && <Badge>Walk-in</Badge>}
            {c.hasAccount && <Badge tone="green">Has account</Badge>}
          </div>
          <dl className="detail-grid mt">
            <div><dt>Phone</dt><dd>{c.phone ? <a href={`tel:${c.phone}`}>{c.phone}</a> : '—'}</dd></div>
            <div><dt>Email</dt><dd>{c.email || '—'}</dd></div>
            <div><dt>Customer since</dt><dd>{fmtDateTime(c.createdAt)}</dd></div>
            <div><dt>Bookings</dt><dd>{data.bookings.filter((b) => b.status === 'confirmed').length} confirmed</dd></div>
          </dl>
          {c.id !== me?.id && (
            <div className="row gap-sm wrap mt">
              {c.hasAccount && <Button variant="outline" size="sm" icon="shield" onClick={() => makeAdmin(c.role !== 'admin')}>{c.role === 'admin' ? 'Remove admin' : 'Make admin'}</Button>}
              <Button variant={c.isBlocked ? 'outline' : 'ghost-danger'} size="sm" icon="ban" onClick={() => block(!c.isBlocked)}>{c.isBlocked ? 'Re-activate' : 'Suspend'}</Button>
            </div>
          )}
          <div className="section-block">
            <h3>Bookings</h3>
            {data.bookings.length === 0 && <p className="muted">No bookings yet.</p>}
            {data.bookings.map((b) => (
              <button key={b.id} className="list-row" onClick={() => setOpenBooking(b.id)}>
                <div className="grow">
                  <div className="cell-strong">{b.facility.name} <span className="resource-tag">{b.resource.name}</span></div>
                  <div className="cell-sub">{fmtDate(b.date)} · {fmtRange(b.startMinute, b.endMinute)} · {b.ref}</div>
                </div>
                <div className="num"><div className="cell-strong">{money(b.amounts.total)}</div><StatusBadge status={b.displayStatus} /></div>
              </button>
            ))}
          </div>
        </>
      )}
      <BookingDrawer id={openBooking} onClose={() => setOpenBooking(null)} onChanged={() => reload({ silent: true })} />
    </Modal>
  );
}

export default function Customers() {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [openId, setOpenId] = useState(null);
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const { data, loading, error, reload } = useAsync(() => api(`/admin/customers?limit=200${debounced ? `&q=${encodeURIComponent(debounced)}` : ''}`), [debounced]);

  return (
    <>
      <PageHead title="Customers" sub={data ? `${data.total} people` : ' '} />
      <div className="toolbar">
        <Field label="Search" className="grow-field"><input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, phone or email" /></Field>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Customer</th><th>Contact</th><th className="num">Bookings</th><th className="num">Spent</th><th>Last booking</th><th /></tr></thead>
          <tbody>
            {loading && !data && Array.from({ length: 6 }, (_, i) => <tr key={i}><td colSpan={6}><Skeleton h={18} /></td></tr>)}
            {data?.customers.map((c) => (
              <tr key={c.id} className="clickable" onClick={() => setOpenId(c.id)}>
                <td className="cell-strong">{c.name || '—'}</td>
                <td><div>{c.phone || '—'}</div><div className="cell-sub">{c.email}</div></td>
                <td className="num">{c.bookings}</td>
                <td className="num">{money(c.spent)}</td>
                <td>{c.lastBooking ? fmtDateTime(c.lastBooking) : '—'}</td>
                <td>
                  <div className="row gap-sm">
                    {c.role === 'admin' && <Badge tone="lime">Admin</Badge>}
                    {c.isBlocked && <Badge tone="red">Suspended</Badge>}
                    {c.isWalkIn && <Badge>Walk-in</Badge>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.customers.length === 0 && <Empty icon="users" title="No customers found" />}
      </div>
      <CustomerModal id={openId} onClose={() => setOpenId(null)} onChanged={() => reload({ silent: true })} />
    </>
  );
}
