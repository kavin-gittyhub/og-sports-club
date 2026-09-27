import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/auth.jsx';
import { money, fmtMin, fmtDays, DAY_NAMES, rupeesToPaise, paiseToRupees, addDays, dayOfWeek } from '../../lib/format.js';
import { Icon } from '../../components/Icons.jsx';
import { SportBadge } from '../../components/SportArt.jsx';
import { Button, ErrorBox, Field, Modal, Toggle, Empty, useToast, useConfirm, Badge, useAsync } from '../../components/ui.jsx';
import { PageHead, TimeSelect, RupeeInput, useAdminFacilities, invalidateFacilities } from './shared.jsx';

function RuleModal({ facility, rule, onClose, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState(() => rule ? {
    label: rule.label, days: rule.days || [0, 1, 2, 3, 4, 5, 6], startMinute: rule.startMinute, endMinute: rule.endMinute,
    price: paiseToRupees(rule.pricePerHour), priority: rule.priority, validFrom: rule.validFrom || '', validUntil: rule.validUntil || '', isActive: rule.isActive,
  } : { label: '', days: [1, 2, 3, 4, 5], startMinute: 17 * 60, endMinute: 1440, price: '', priority: 10, validFrom: '', validUntil: '', isActive: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const body = { label: f.label, days: f.days, startMinute: f.startMinute, endMinute: f.endMinute, pricePerHour: rupeesToPaise(f.price), priority: Number(f.priority), validFrom: f.validFrom, validUntil: f.validUntil, isActive: f.isActive };
      if (rule) await api(`/admin/pricing/${rule.id}`, { method: 'PATCH', body });
      else await api('/admin/pricing', { method: 'POST', body: { ...body, facilityId: facility.id } });
      toast.success('Price saved');
      invalidateFacilities();
      onSaved();
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={rule ? 'Edit price' : `New price · ${facility.name}`} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={busy} disabled={!f.label || f.price === ''}>Save</Button></>}>
      <ErrorBox error={error} />
      <div className="stack">
        <div className="form-grid cols-2">
          <Field label="Name"><input className="input" value={f.label} onChange={(e) => set('label')(e.target.value)} placeholder="e.g. Evening peak" /></Field>
          <Field label="Price per hour"><RupeeInput value={f.price} onChange={set('price')} /></Field>
        </div>
        <Field label="Days">
          <div className="day-picks">
            {DAY_NAMES.map((d, i) => (
              <button key={d} type="button" className={`day-pick ${f.days.includes(i) ? 'is-on' : ''}`} aria-pressed={f.days.includes(i)} onClick={() => set('days')(f.days.includes(i) ? f.days.filter((x) => x !== i) : [...f.days, i])}>{d}</button>
            ))}
          </div>
        </Field>
        <div className="form-grid cols-3">
          <Field label="From"><TimeSelect value={f.startMinute} onChange={set('startMinute')} /></Field>
          <Field label="To"><TimeSelect value={f.endMinute} onChange={set('endMinute')} from={15} to={1440} includeEnd /></Field>
          <Field label="Priority" hint="Higher wins when rules overlap"><input className="input" type="number" min="0" max="1000" value={f.priority} onChange={(e) => set('priority')(e.target.value)} /></Field>
          <Field label="Valid from (optional)"><input className="input" type="date" value={f.validFrom} onChange={(e) => set('validFrom')(e.target.value)} /></Field>
          <Field label="Valid until (optional)"><input className="input" type="date" value={f.validUntil} onChange={(e) => set('validUntil')(e.target.value)} /></Field>
          <Field label="Status"><Toggle checked={f.isActive} onChange={set('isActive')} label={f.isActive ? 'Active' : 'Off'} /></Field>
        </div>
        <p className="muted small">Tip: a booking that crosses two rules (e.g. 4:30–5:30 PM) is charged minute-by-minute at each rule’s rate.</p>
      </div>
    </Modal>
  );
}

function Preview({ facility }) {
  const { config } = useSession();
  const today = config?.today;
  const nextOf = (dow) => { for (let i = 0; i < 7; i++) { const d = addDays(today, i); if (dayOfWeek(d) === dow) return d; } return today; };
  const [date, setDate] = useState(null);
  useEffect(() => { if (today) setDate(nextOf(1)); }, [today]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data } = useAsync(() => (date ? api(`/admin/pricing/preview?facilityId=${facility.id}&date=${date}`) : Promise.resolve(null)), [facility.id, date, facility.pricing]);
  return (
    <section className="card">
      <h2 className="card-title"><Icon name="rupee" size={20} />What customers pay for 1 hour</h2>
      <div className="row gap-sm wrap" style={{ marginBottom: 10 }}>
        <button className={`fac-tab ${date && dayOfWeek(date) !== 0 && dayOfWeek(date) !== 6 ? 'is-active' : ''}`} onClick={() => setDate(nextOf(1))}>Weekday</button>
        <button className={`fac-tab ${date && (dayOfWeek(date) === 0 || dayOfWeek(date) === 6) ? 'is-active' : ''}`} onClick={() => setDate(nextOf(6))}>Weekend</button>
        <input className="input" style={{ width: 170 }} type="date" value={date || ''} onChange={(e) => setDate(e.target.value)} />
      </div>
      <div className="price-strip">
        {data?.hours.map((h) => (
          <div key={h.startMinute} className="price-strip-cell">
            <div className="t">{fmtMin(h.startMinute).replace(':00', '')}</div>
            <div className="p">{h.amount === null ? '—' : money(h.amount)}</div>
          </div>
        ))}
      </div>
      {facility.supportsBowlingMachine && <p className="muted small mt-sm">+ Bowling machine {money(facility.bowlingMachinePricePerHour)}/hr (edit in Facilities).</p>}
    </section>
  );
}

export default function Pricing() {
  const toast = useToast();
  const confirm = useConfirm();
  const { facilities, error, reload } = useAdminFacilities();
  const [selected, setSelected] = useState(null);
  const [editing, setEditing] = useState(null); // rule | 'new'
  const fac = facilities?.find((f) => f.id === selected) || facilities?.[0];

  const remove = async (r) => {
    if (!(await confirm({ title: `Delete “${r.label}”?`, message: 'Times it covered will fall back to other rules. Make sure every opening hour still has a price.', confirmText: 'Delete', danger: true }))) return;
    try { await api(`/admin/pricing/${r.id}`, { method: 'DELETE' }); toast.success('Deleted'); invalidateFacilities(); reload(); } catch (e) { toast.error(e.message); }
  };

  return (
    <>
      <PageHead title="Pricing" sub="Hourly rates by day and time. The server always calculates the final price." />
      <ErrorBox error={error} onRetry={reload} />
      <div className="fac-tabs">
        {facilities?.map((f) => (
          <button key={f.id} className={`fac-tab ${fac?.id === f.id ? 'is-active' : ''}`} onClick={() => setSelected(f.id)}><SportBadge sport={f.sport} size={24} />{f.name}</button>
        ))}
      </div>
      {fac && (
        <div className="stack">
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th><th>Days</th><th>Time</th><th className="num">Per hour</th><th>Priority</th><th /></tr></thead>
              <tbody>
                {fac.pricing.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => setEditing(r)}>
                    <td className="cell-strong">{r.label} {!r.isActive && <Badge>Off</Badge>}{(r.validFrom || r.validUntil) && <div className="cell-sub">{r.validFrom || '…'} → {r.validUntil || '…'}</div>}</td>
                    <td>{fmtDays(r.days)}</td>
                    <td>{r.startMinute === 0 && r.endMinute === 1440 ? 'All day' : `${fmtMin(r.startMinute)} – ${fmtMin(r.endMinute)}`}</td>
                    <td className="num cell-strong">{money(r.pricePerHour)}</td>
                    <td>{r.priority}</td>
                    <td className="num" onClick={(e) => e.stopPropagation()}>
                      <Button variant="ghost" size="sm" icon="edit" onClick={() => setEditing(r)} aria-label="Edit" />
                      <Button variant="ghost-danger" size="sm" icon="trash" onClick={() => remove(r)} aria-label="Delete" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {fac.pricing.length === 0 && <Empty icon="rupee" title="No prices yet">Add at least one rule so customers can book.</Empty>}
          </div>
          <div><Button icon="plus" onClick={() => setEditing('new')}>Add price rule</Button></div>
          <Preview facility={fac} />
        </div>
      )}
      {editing && fac && <RuleModal facility={fac} rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={reload} />}
    </>
  );
}
