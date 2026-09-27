import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/auth.jsx';
import { fmtDate, fmtMin, fmtRange, fmtDays, DAY_NAMES, addDays } from '../../lib/format.js';

import { Icon } from '../../components/Icons.jsx';
import { Button, ErrorBox, Field, Empty, Toggle, useAsync, useToast, useConfirm, Badge } from '../../components/ui.jsx';
import { PageHead, TimeSelect, useAdminFacilities } from './shared.jsx';

function blockLabel(b) {
  if (b.startMinute === 0 && b.endMinute === 0 && b.endDate > b.startDate) {
    const last = addDays(b.endDate, -1);
    return last === b.startDate ? `${fmtDate(b.startDate)} · All day` : `${fmtDate(b.startDate)} – ${fmtDate(last)} · All day`;
  }
  if (b.startDate === b.endDate) return `${fmtDate(b.startDate)} · ${fmtMin(b.startMinute)} – ${fmtMin(b.endMinute)}`;
  return `${fmtDate(b.startDate)} ${fmtMin(b.startMinute)} → ${fmtDate(b.endDate)} ${fmtMin(b.endMinute)}`;
}

function BlockForm({ facilities, today, onCreated }) {
  const toast = useToast();
  const [kind, setKind] = useState('once');
  const [f, setF] = useState({ facilityId: '', resourceId: '', startDate: today, endDate: today, startMinute: 6 * 60, endMinute: 23 * 60, allDay: false, days: [1, 2, 3, 4, 5], validFrom: today, validUntil: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [conflicts, setConflicts] = useState(null);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const fac = facilities.find((x) => x.id === Number(f.facilityId));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null); setConflicts(null);
    try {
      const common = { facilityId: Number(f.facilityId), resourceId: f.resourceId ? Number(f.resourceId) : undefined, reason: f.reason };
      const res = kind === 'once'
        ? await api('/admin/blocks', { method: 'POST', body: { ...common, startDate: f.startDate, endDate: f.allDay ? f.endDate : f.startDate, startMinute: f.allDay ? 0 : f.startMinute, endMinute: f.allDay ? 1440 : f.endMinute } })
        : await api('/admin/recurring-blocks', { method: 'POST', body: { ...common, days: f.days, startMinute: f.startMinute, endMinute: f.endMinute, validFrom: f.validFrom, validUntil: f.validUntil || undefined } });
      toast.success('Block saved — those times are no longer bookable.');
      setConflicts(res.conflicts);
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2 className="card-title"><Icon name="ban" size={20} />Block time</h2>
      <div className="tabs" style={{ marginTop: 0 }}>
        <button type="button" className={`tab ${kind === 'once' ? 'is-active' : ''}`} onClick={() => setKind('once')}>One-time</button>
        <button type="button" className={`tab ${kind === 'recurring' ? 'is-active' : ''}`} onClick={() => setKind('recurring')}>Recurring</button>
      </div>
      <ErrorBox error={error} />
      <div className="stack">
        <div className="form-grid cols-2">
          <Field label="Facility">
            <select className="select" required value={f.facilityId} onChange={(e) => setF((x) => ({ ...x, facilityId: e.target.value, resourceId: '' }))}>
              <option value="">Choose…</option>
              {facilities.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </Field>
          <Field label="What to block">
            <select className="select" value={f.resourceId} onChange={(e) => set('resourceId')(e.target.value)} disabled={!fac}>
              <option value="">Entire facility</option>
              {fac?.resources.map((r) => <option key={r.id} value={r.id}>Only {r.name}</option>)}
            </select>
          </Field>
        </div>
        {kind === 'once' ? (
          <>
            <Toggle checked={f.allDay} onChange={set('allDay')} label="Whole day(s)" />
            {f.allDay ? (
              <div className="form-grid cols-2">
                <Field label="From date"><input className="input" type="date" required value={f.startDate} onChange={(e) => set('startDate')(e.target.value)} /></Field>
                <Field label="To date (inclusive)"><input className="input" type="date" required value={f.endDate} min={f.startDate} onChange={(e) => set('endDate')(e.target.value)} /></Field>
              </div>
            ) : (
              <div className="form-grid cols-3">
                <Field label="Date"><input className="input" type="date" required value={f.startDate} onChange={(e) => set('startDate')(e.target.value)} /></Field>
                <Field label="From"><TimeSelect value={f.startMinute} onChange={set('startMinute')} /></Field>
                <Field label="To"><TimeSelect value={f.endMinute} onChange={set('endMinute')} from={15} to={1440} includeEnd /></Field>
              </div>
            )}
          </>
        ) : (
          <>
            <Field label="Repeat on">
              <div className="day-picks">
                {DAY_NAMES.map((d, i) => (
                  <button key={d} type="button" className={`day-pick ${f.days.includes(i) ? 'is-on' : ''}`} aria-pressed={f.days.includes(i)} onClick={() => set('days')(f.days.includes(i) ? f.days.filter((x) => x !== i) : [...f.days, i])}>{d}</button>
                ))}
              </div>
            </Field>
            <div className="form-grid cols-2">
              <Field label="From"><TimeSelect value={f.startMinute} onChange={set('startMinute')} /></Field>
              <Field label="To"><TimeSelect value={f.endMinute} onChange={set('endMinute')} from={15} to={1440} includeEnd /></Field>
              <Field label="Starting"><input className="input" type="date" value={f.validFrom} onChange={(e) => set('validFrom')(e.target.value)} /></Field>
              <Field label="Until (optional)"><input className="input" type="date" value={f.validUntil} onChange={(e) => set('validUntil')(e.target.value)} /></Field>
            </div>
          </>
        )}
        <Field label="Reason" hint="Internal — customers just see the time as unavailable.">
          <input className="input" value={f.reason} onChange={(e) => set('reason')(e.target.value)} placeholder={kind === 'once' ? 'e.g. Maintenance, tournament' : 'e.g. Academy coaching'} maxLength={200} />
        </Field>
        <Button type="submit" loading={busy} icon="lock" disabled={!f.facilityId || (kind === 'recurring' && !f.days.length)}>Save block</Button>
        {conflicts && conflicts.length > 0 && (
          <div className="alert alert-warn">
            <Icon name="alert" />
            <div>
              <strong>{conflicts.length} existing booking{conflicts.length > 1 ? 's' : ''} overlap this block.</strong> They are kept — contact the customers or cancel them from Bookings:
              <ul>{conflicts.slice(0, 8).map((b) => <li key={b.id}>{b.customer.name} · {fmtDate(b.date)} {fmtRange(b.startMinute, b.endMinute)} · {b.resource.name}</li>)}</ul>
            </div>
          </div>
        )}
      </div>
    </form>
  );
}

export default function Blocks() {
  const { config } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const { facilities } = useAdminFacilities();
  const { data, error, reload } = useAsync(() => api('/admin/blocks'), []);

  const del = async (b) => {
    if (!(await confirm({ title: 'Remove this block?', message: 'Those times become bookable again.', confirmText: 'Remove', danger: true }))) return;
    try { await api(`/admin/blocks/${b.id}`, { method: 'DELETE' }); toast.success('Block removed'); reload({ silent: true }); } catch (e) { toast.error(e.message); }
  };
  const delRec = async (r) => {
    if (!(await confirm({ title: 'Delete recurring block?', message: 'All future occurrences become bookable.', confirmText: 'Delete', danger: true }))) return;
    try { await api(`/admin/recurring-blocks/${r.id}`, { method: 'DELETE' }); toast.success('Recurring block deleted'); reload({ silent: true }); } catch (e) { toast.error(e.message); }
  };
  const toggleRec = async (r, active) => {
    try { await api(`/admin/recurring-blocks/${r.id}`, { method: 'PATCH', body: { active } }); reload({ silent: true }); } catch (e) { toast.error(e.message); }
  };

  return (
    <>
      <PageHead title="Blocks" sub="Close a whole facility or a single net/court for maintenance, events or coaching." />
      <div className="split">
        <div className="stack">
          <ErrorBox error={error} onRetry={reload} />
          <section className="card">
            <h2 className="card-title">Upcoming one-time blocks</h2>
            {data?.blocks.length === 0 && <Empty icon="check" title="No upcoming blocks" />}
            {data?.blocks.map((b) => (
              <div key={b.id} className="list-row">
                <Icon name="lock" />
                <div className="grow">
                  <div className="cell-strong">{b.facilityName} · {b.resourceName ? <span className="resource-tag">{b.resourceName}</span> : 'Entire facility'}</div>
                  <div className="cell-sub">
                    {blockLabel(b)}
                    {b.reason && ` · ${b.reason}`}
                  </div>
                </div>
                <Button variant="ghost-danger" size="sm" icon="trash" onClick={() => del(b)} aria-label="Remove block" />
              </div>
            ))}
          </section>
          <section className="card">
            <h2 className="card-title">Recurring blocks</h2>
            {data?.recurring.length === 0 && <Empty icon="refresh" title="No recurring blocks" />}
            {data?.recurring.map((r) => (
              <div key={r.id} className="list-row">
                <Icon name="refresh" />
                <div className="grow">
                  <div className="cell-strong">{r.facilityName} · {r.resourceName ? <span className="resource-tag">{r.resourceName}</span> : 'Entire facility'} {!r.active && <Badge>Paused</Badge>}</div>
                  <div className="cell-sub">{fmtDays(r.days)} · {fmtMin(r.startMinute)} – {fmtMin(r.endMinute)} · from {fmtDate(r.validFrom)}{r.validUntil ? ` until ${fmtDate(r.validUntil)}` : ''}{r.reason && ` · ${r.reason}`}</div>
                </div>
                <Toggle checked={r.active} onChange={(v) => toggleRec(r, v)} />
                <Button variant="ghost-danger" size="sm" icon="trash" onClick={() => delRec(r)} aria-label="Delete recurring block" />
              </div>
            ))}
          </section>
        </div>
        {facilities && config?.today && <BlockForm facilities={facilities} today={config.today} onCreated={() => reload({ silent: true })} />}
      </div>
    </>
  );
}
