import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { money, fmtDateLong, fmtRange, fmtDuration, fmtDateTime, PAYMENT_LABEL, rupeesToPaise, paiseToRupees } from '../../lib/format.js';
import { Icon } from '../../components/Icons.jsx';
import { Button, Modal, Spinner, StatusBadge, PaymentBadge, Field, Toggle, ErrorBox, useToast, Badge } from '../../components/ui.jsx';
import { TimeSelect, DurationSelect, RupeeInput } from './shared.jsx';

function EditForm({ data, onSaved, onCancel }) {
  const toast = useToast();
  const b = data.booking;
  const [form, setForm] = useState({
    date: b.date, startMinute: b.startMinute, durationMin: b.durationMin, resourceIds: (b.resources || [b.resource]).map((r) => r.id),
    bowlingMachine: b.bowlingMachine, total: paiseToRupees(b.amounts.total), notes: b.notes || '', reprice: false,
  });
  const [quote, setQuote] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const qty = b.quantity || 1;
  const unit = b.facility.unitLabel || 'unit';
  const toggleUnit = (id) => setForm((f) => {
    if (qty === 1) return { ...f, resourceIds: [id] };
    const has = f.resourceIds.includes(id);
    if (has) return { ...f, resourceIds: f.resourceIds.filter((x) => x !== id) };
    if (f.resourceIds.length >= qty) return f;
    return { ...f, resourceIds: [...f.resourceIds, id] };
  });

  useEffect(() => {
    const t = setTimeout(() => {
      api('/admin/quote', { method: 'POST', body: { facilityId: b.facility.id, date: form.date, startMinute: form.startMinute, durationMin: form.durationMin, bowlingMachine: form.bowlingMachine, excludeBookingId: b.id } })
        .then(setQuote).catch(() => setQuote(null));
    }, 200);
    return () => clearTimeout(t);
  }, [form.date, form.startMinute, form.durationMin, form.bowlingMachine, b.facility.id, b.id]);

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      const body = {
        date: form.date, startMinute: form.startMinute, durationMin: form.durationMin,
        bowlingMachine: form.bowlingMachine, notes: form.notes, reprice: form.reprice,
      };
      const original = (b.resources || [b.resource]).map((r) => r.id).sort().join(',');
      if ([...form.resourceIds].sort().join(',') !== original) {
        if (form.resourceIds.length !== qty) throw new Error(`Select exactly ${qty} ${unit}${qty > 1 ? 's' : ''}.`);
        body.resourceIds = form.resourceIds;
      }
      if (!form.reprice && rupeesToPaise(form.total) !== b.amounts.total) body.totalAmount = rupeesToPaise(form.total);
      await api(`/admin/bookings/${b.id}`, { method: 'PATCH', body });
      toast.success('Booking updated');
      onSaved();
    } catch (e) {
      setErr(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stack">
      <ErrorBox error={err} />
      <div className="form-grid cols-3">
        <Field label="Date"><input className="input" type="date" value={form.date} onChange={(e) => set('date')(e.target.value)} /></Field>
        <Field label="Start"><TimeSelect value={form.startMinute} onChange={set('startMinute')} step={5} /></Field>
        <Field label="Duration"><DurationSelect value={form.durationMin} onChange={set('durationMin')} min={15} max={480} step={15} /></Field>
      </div>
      <Field label={qty > 1 ? `Assigned ${unit}s (pick ${qty})` : 'Assigned resource'} hint="Customers never see this — it’s for your staff. If a unit is busy at the new time, another free one is chosen automatically.">
        <div className="pick-grid">
          {(quote?.resources || data.resources.map((r) => ({ ...r, free: true }))).map((r) => (
            <button key={r.id} type="button" className={`pick ${form.resourceIds.includes(r.id) ? 'is-on' : ''}`} disabled={!r.free && !form.resourceIds.includes(r.id)} onClick={() => toggleUnit(r.id)}>
              <span>{r.name}<small>{r.free ? 'Free' : 'Busy'}</small></span>
            </button>
          ))}
        </div>
      </Field>
      {quote && quote.bowlingMachineAvailable !== null && (
        <Toggle checked={form.bowlingMachine} onChange={set('bowlingMachine')} label={`Bowling machine${quote && !quote.bowlingMachineAvailable && !b.bowlingMachine ? ' (busy)' : ''}`} />
      )}
      <div className="form-grid cols-2">
        <Field label="Total amount" hint={quote?.price ? `Standard price: ${money(quote.price.total)}` : undefined}>
          <RupeeInput value={form.total} onChange={set('total')} disabled={form.reprice} />
        </Field>
        <Field label="Pricing"><Toggle checked={form.reprice} onChange={set('reprice')} label="Recalculate from price list" /></Field>
      </div>
      <Field label="Internal notes"><textarea className="textarea" value={form.notes} onChange={(e) => set('notes')(e.target.value)} maxLength={500} /></Field>
      {quote?.outsideHours && <div className="alert alert-warn"><Icon name="info" /><div>This time is outside normal opening hours — allowed for admin bookings.</div></div>}
      <div className="row gap-sm">
        <Button onClick={save} loading={saving} icon="check">Save changes</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function CancelForm({ data, onDone, onBack }) {
  const toast = useToast();
  const b = data.booking;
  const paidOnline = data.payments.filter((p) => ['paid', 'partially_refunded'].includes(p.status)).reduce((s, p) => s + p.amount - p.refundAmount, 0);
  const [refund, setRefund] = useState(paiseToRupees(paidOnline));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const res = await api(`/admin/bookings/${b.id}/cancel`, { method: 'POST', body: { refundAmount: rupeesToPaise(refund || 0), reason: reason || undefined } });
      if (res.refund.errors?.length) toast.error(`Cancelled, but refund failed: ${res.refund.errors[0]}`);
      else toast.success(res.refund.processed > 0 ? `Cancelled and refunded ${money(res.refund.processed)}` : 'Booking cancelled');
      onDone();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <div className="alert alert-warn"><Icon name="alert" /><div>This releases <strong>{b.resource.name}</strong> for {fmtRange(b.startMinute, b.endMinute)}. The customer’s booking will show as cancelled.</div></div>
      <Field label="Refund amount" hint={paidOnline > 0 ? `Paid so far: ${money(paidOnline)}. Online payments are refunded automatically; record cash refunds at the desk.` : 'Nothing has been paid yet.'}>
        <RupeeInput value={refund} onChange={setRefund} max={paiseToRupees(paidOnline)} disabled={paidOnline === 0} />
      </Field>
      <Field label="Reason (optional)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Rain, maintenance, customer request" /></Field>
      <div className="row gap-sm">
        <Button variant="danger" onClick={submit} loading={busy}>Cancel booking</Button>
        <Button variant="ghost" onClick={onBack}>Go back</Button>
      </div>
    </div>
  );
}

function RecordPayment({ data, onDone, onBack }) {
  const toast = useToast();
  const b = data.booking;
  const paid = data.payments.filter((p) => p.status === 'paid').reduce((s, p) => s + p.amount, 0);
  const [amount, setAmount] = useState(paiseToRupees(Math.max(0, b.amounts.total - paid)));
  const [method, setMethod] = useState('cash');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api(`/admin/bookings/${b.id}/payments`, { method: 'POST', body: { method, amount: rupeesToPaise(amount) } });
      toast.success('Payment recorded');
      onDone();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <Field label="Method">
        <div className="pick-grid">
          {[['cash', 'Cash'], ['upi_offline', 'UPI (at desk)'], ['card_offline', 'Card (at desk)']].map(([v, l]) => (
            <button key={v} type="button" className={`pick ${method === v ? 'is-on' : ''}`} onClick={() => setMethod(v)}>{l}</button>
          ))}
        </div>
      </Field>
      <Field label="Amount received"><RupeeInput value={amount} onChange={setAmount} /></Field>
      <div className="row gap-sm">
        <Button onClick={submit} loading={busy} icon="check">Record payment</Button>
        <Button variant="ghost" onClick={onBack}>Go back</Button>
      </div>
    </div>
  );
}

export function BookingDrawer({ id, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState('view');
  const load = () => {
    setError(null);
    return api(`/admin/bookings/${id}`).then(setData).catch(setError);
  };
  useEffect(() => { setData(null); setMode('view'); if (id) load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = async () => { await load(); setMode('view'); onChanged?.(); };
  const b = data?.booking;
  const live = b && ['confirmed', 'pending_payment'].includes(b.status);

  return (
    <Modal open={Boolean(id)} onClose={onClose} title={b ? `Booking ${b.ref}` : 'Booking'} size="lg">
      <ErrorBox error={error} onRetry={load} />
      {!data && !error && <div className="center-x"><Spinner size={24} /></div>}
      {b && mode === 'view' && (
        <>
          <div className="row gap-sm wrap">
            <StatusBadge status={b.displayStatus} />
            <PaymentBadge status={b.paymentStatus} />
            <Badge tone={b.source === 'admin' ? 'blue' : 'lime'}>{b.source === 'admin' ? 'Manual' : 'Online'}</Badge>
          </div>
          <dl className="detail-grid mt">
            <div><dt>Customer</dt><dd>{b.customer.name || '—'}{b.customer.walkIn && <span className="muted small"> (walk-in)</span>}</dd></div>
            <div><dt>Contact</dt><dd>{b.customer.phone ? <a href={`tel:${b.customer.phone}`}>{b.customer.phone}</a> : '—'}<br /><span className="small muted">{b.customer.email}</span></dd></div>
            <div><dt>Facility</dt><dd>{b.facility.name}{b.quantity > 1 ? ` × ${b.quantity} ${b.facility.unitLabel}s` : ''}</dd></div>
            <div><dt>Assigned to</dt><dd><span className="row gap-sm wrap">{(b.resources || [b.resource]).map((r) => <span key={r.id} className="resource-tag">{r.name}</span>)}</span></dd></div>
            <div><dt>Date</dt><dd>{fmtDateLong(b.date)}</dd></div>
            <div><dt>Time</dt><dd>{fmtRange(b.startMinute, b.endMinute)} · {fmtDuration(b.durationMin)}</dd></div>
            <div><dt>Bowling machine</dt><dd>{b.bowlingMachine ? 'Yes' : 'No'}</dd></div>
            <div><dt>Amount</dt><dd>{money(b.amounts.total)}{b.amounts.refund > 0 && <span className="muted small"> · refunded {money(b.amounts.refund)}</span>}</dd></div>
          </dl>
          {b.notes && <div className="alert alert-info mt"><Icon name="info" /><div>{b.notes}</div></div>}
          {b.cancelReason && <p className="muted small mt">Cancellation reason: {b.cancelReason}</p>}

          {live && (
            <div className="row gap-sm wrap mt-lg">
              <Button variant="dark" icon="edit" onClick={() => setMode('edit')}>Edit / move</Button>
              {['unpaid', 'pay_at_venue'].includes(b.paymentStatus) && <Button variant="outline" icon="rupee" onClick={() => setMode('pay')}>Record payment</Button>}
              <Button variant="ghost-danger" icon="ban" onClick={() => setMode('cancel')}>Cancel booking</Button>
            </div>
          )}

          {data.payments.length > 0 && (
            <div className="section-block">
              <h3>Payments</h3>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>When</th><th>Method</th><th>Status</th><th className="num">Amount</th></tr></thead>
                  <tbody>
                    {data.payments.map((p) => (
                      <tr key={p.id}>
                        <td>{fmtDateTime(p.paidAt || p.createdAt)}</td>
                        <td>{p.provider === 'razorpay' ? `Razorpay · ${p.method || '—'}` : p.provider.replace('_offline', ' (desk)')}{p.extensionId ? ' · extension' : ''}</td>
                        <td>{PAYMENT_LABEL[p.status] || p.status}</td>
                        <td className="num">{money(p.amount)}{p.refundAmount > 0 && <div className="cell-sub">−{money(p.refundAmount)}</div>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {data.audit.length > 0 && (
            <div className="section-block">
              <h3>History</h3>
              <ul className="timeline">
                {data.audit.map((a) => (
                  <li key={a.id}><div><strong>{a.action.replace(/[._]/g, ' ')}</strong> <span className="muted">· {a.actor || 'system'} · {fmtDateTime(a.createdAt)}</span></div></li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {b && mode === 'edit' && <EditForm data={data} onSaved={changed} onCancel={() => setMode('view')} />}
      {b && mode === 'cancel' && <CancelForm data={data} onDone={changed} onBack={() => setMode('view')} />}
      {b && mode === 'pay' && <RecordPayment data={data} onDone={changed} onBack={() => setMode('view')} />}
    </Modal>
  );
}
