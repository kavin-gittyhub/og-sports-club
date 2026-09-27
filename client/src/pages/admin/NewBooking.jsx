import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { navigate, useQuery } from '../../lib/router.jsx';
import { useSession } from '../../lib/auth.jsx';
import { money, fmtRange, rupeesToPaise, paiseToRupees } from '../../lib/format.js';
import { Icon } from '../../components/Icons.jsx';
import { SportBadge } from '../../components/SportArt.jsx';
import { Button, ErrorBox, Field, Toggle, Spinner, useToast } from '../../components/ui.jsx';
import { PageHead, TimeSelect, DurationSelect, RupeeInput, useAdminFacilities } from './shared.jsx';

function CustomerPicker({ value, onChange }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return undefined; }
    const t = setTimeout(() => api(`/admin/customers?q=${encodeURIComponent(q.trim())}&limit=8`).then((d) => setResults(d.customers)).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [q]);
  if (value.id) {
    return (
      <div className="resource-item">
        <Icon name="user" />
        <div className="grow"><strong>{value.name}</strong><div className="cell-sub">{value.phone || value.email}</div></div>
        <Button variant="ghost" size="sm" onClick={() => onChange({ name: '', phone: '', email: '' })}>Change</Button>
      </div>
    );
  }
  return (
    <div className="stack">
      <Field label="Find existing customer">
        <input className="input" type="search" placeholder="Search name, phone or email" value={q} onChange={(e) => setQ(e.target.value)} />
        {results.length > 0 && (
          <div className="search-results">
            {results.map((c) => (
              <button key={c.id} type="button" onClick={() => { onChange({ id: c.id, name: c.name, phone: c.phone, email: c.email }); setQ(''); }}>
                <strong>{c.name || 'Unnamed'}</strong> <span className="muted small">{c.phone} {c.email}</span>
              </button>
            ))}
          </div>
        )}
      </Field>
      <div className="muted small">…or enter a walk-in customer:</div>
      <div className="form-grid cols-3">
        <Field label="Name *"><input className="input" value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} placeholder="Customer name" /></Field>
        <Field label="Phone"><input className="input" inputMode="tel" value={value.phone} onChange={(e) => onChange({ ...value, phone: e.target.value })} placeholder="98765 43210" /></Field>
        <Field label="Email"><input className="input" type="email" value={value.email} onChange={(e) => onChange({ ...value, email: e.target.value })} placeholder="optional" /></Field>
      </div>
    </div>
  );
}

export default function NewBooking() {
  const toast = useToast();
  const { config } = useSession();
  const q = useQuery();
  const { facilities } = useAdminFacilities();
  const [form, setForm] = useState(() => ({
    facilityId: q.get('facility') ? Number(q.get('facility')) : null,
    resourceId: q.get('resource') ? Number(q.get('resource')) : null,
    date: q.get('date') || config?.today || '',
    startMinute: q.get('start') ? Number(q.get('start')) : 18 * 60,
    durationMin: 60,
    quantity: 1,
    bowlingMachine: false,
    paymentMode: 'pay_at_venue',
    amount: '',
    amountTouched: false,
    notes: '',
  }));
  const [customer, setCustomer] = useState({ name: '', phone: '', email: '' });
  const [quote, setQuote] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const fac = facilities?.find((f) => f.id === form.facilityId);

  useEffect(() => { if (!form.date && config?.today) set('date')(config.today); }, [config]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!form.facilityId || !form.date) { setQuote(null); return undefined; }
    const t = setTimeout(() => {
      api('/admin/quote', { method: 'POST', body: { facilityId: form.facilityId, date: form.date, startMinute: form.startMinute, durationMin: form.durationMin, bowlingMachine: form.bowlingMachine, quantity: form.quantity } })
        .then((d) => {
          setQuote(d);
          if (d.price) setForm((f) => (f.amountTouched ? f : { ...f, amount: String(paiseToRupees(d.price.total)) }));
        })
        .catch((e) => setQuote({ error: e.message }));
    }, 200);
    return () => clearTimeout(t);
  }, [form.facilityId, form.date, form.startMinute, form.durationMin, form.bowlingMachine, form.quantity]);

  const selectedResourceBusy = form.resourceId && quote?.resources?.find((r) => r.id === form.resourceId && !r.free);
  const freeCount = quote?.resources ? quote.resources.filter((r) => r.free).length : null;
  const noneFree = freeCount !== null && freeCount < form.quantity;

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!customer.id && customer.name.trim().length < 2) { setError(new Error('Please enter the customer’s name or pick an existing customer.')); return; }
    setSaving(true);
    try {
      const body = {
        facilityId: form.facilityId, date: form.date, startMinute: form.startMinute, durationMin: form.durationMin,
        bowlingMachine: form.bowlingMachine, quantity: form.quantity, resourceId: form.quantity === 1 ? form.resourceId || undefined : undefined, paymentMode: form.paymentMode,
        amount: form.amount === '' ? undefined : rupeesToPaise(form.amount), notes: form.notes || undefined,
        ...(customer.id ? { customerId: customer.id } : { customerName: customer.name.trim(), customerPhone: customer.phone.trim() || undefined, customerEmail: customer.email.trim() || undefined }),
      };
      const { booking } = await api('/admin/bookings', { method: 'POST', body });
      toast.success(`Booked ${booking.resource.name} for ${booking.customer.name} (${booking.ref})`);
      navigate(`/admin/timetable?date=${booking.date}`);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ maxWidth: 860 }}>
      <PageHead title="New booking" sub="For phone, WhatsApp and walk-in customers. Confirmed immediately." />
      <ErrorBox error={error} />
      <div className="stack">
        <section className="card">
          <h2 className="card-title">1 · Facility</h2>
          <div className="pick-grid">
            {facilities?.filter((f) => f.isActive).map((f) => (
              <button key={f.id} type="button" className={`pick ${form.facilityId === f.id ? 'is-on' : ''}`} onClick={() => setForm((x) => ({ ...x, facilityId: f.id, resourceId: null, quantity: 1, bowlingMachine: false, amountTouched: false }))}>
                <SportBadge sport={f.sport} size={28} />{f.name}
              </button>
            ))}
            {!facilities && <Spinner />}
          </div>
        </section>

        {fac && (
          <section className="card">
            <h2 className="card-title">2 · Date & time</h2>
            <div className="form-grid cols-3">
              <Field label="Date"><input className="input" type="date" required value={form.date} onChange={(e) => set('date')(e.target.value)} /></Field>
              <Field label="Start time"><TimeSelect value={form.startMinute} onChange={set('startMinute')} step={5} from={0} to={1440} /></Field>
              <Field label="Duration"><DurationSelect value={form.durationMin} onChange={set('durationMin')} min={15} max={Math.max(fac.maxDurationMin, 240)} step={15} /></Field>
            </div>
            <p className="muted small mt-sm">{fmtRange(form.startMinute, form.startMinute + form.durationMin)} · Open {fmtRange(fac.openMinute, fac.closeMinute)}</p>
            {quote?.outsideHours && <div className="alert alert-warn mt-sm"><Icon name="info" /><div>Outside opening hours — allowed for manual bookings.</div></div>}

            {fac.resources.filter((r) => r.isActive).length > 1 && (
              <Field label={`How many ${fac.unitLabel || 'unit'}s?`} className="mt">
                <div className="pick-grid">
                  {Array.from({ length: fac.resources.filter((r) => r.isActive).length }, (_, i) => i + 1).map((n) => (
                    <button key={n} type="button" className={`pick ${form.quantity === n ? 'is-on' : ''}`} onClick={() => setForm((f) => ({ ...f, quantity: n, resourceId: null, amountTouched: false }))}>{n} {fac.unitLabel || 'unit'}{n > 1 ? 's' : ''}</button>
                  ))}
                </div>
              </Field>
            )}
            {form.quantity > 1 ? (
              <p className="muted small mt">Will assign: <strong>{quote?.suggestedIds?.length === form.quantity ? quote.resources.filter((r) => quote.suggestedIds.includes(r.id)).map((r) => r.name).join(' + ') : '—'}</strong></p>
            ) : (
            <Field label="Assign to" hint="Auto picks the best free unit. Customers never see this." className="mt">
              <div className="pick-grid">
                <button type="button" className={`pick ${!form.resourceId ? 'is-on' : ''}`} onClick={() => set('resourceId')(null)}>
                  <span>Auto<small>{quote?.suggested ? `→ ${quote.resources.find((r) => r.id === quote.suggested)?.name}` : noneFree ? 'None free' : '…'}</small></span>
                </button>
                {(quote?.resources || fac.resources.filter((r) => r.isActive)).map((r) => (
                  <button key={r.id} type="button" className={`pick ${form.resourceId === r.id ? 'is-on' : ''}`} disabled={r.free === false} onClick={() => set('resourceId')(r.id)}>
                    <span>{r.name}<small>{r.free === undefined ? '' : r.free ? 'Free' : 'Busy'}</small></span>
                  </button>
                ))}
              </div>
            </Field>
            )}
            {noneFree && <div className="alert alert-error mt-sm"><Icon name="alert" /><div>{freeCount > 0 ? `Only ${freeCount} free at this time.` : 'Everything is booked or blocked at this time.'}</div></div>}
            {selectedResourceBusy && <div className="alert alert-error mt-sm"><Icon name="alert" /><div>That unit is busy — choose another or Auto.</div></div>}

            {fac.supportsBowlingMachine && (
              <div className="mt">
                <Toggle checked={form.bowlingMachine} onChange={set('bowlingMachine')} disabled={quote && quote.bowlingMachineAvailable === false && !form.bowlingMachine} label={`Bowling machine (+${money(fac.bowlingMachinePricePerHour)}/hr)${quote?.bowlingMachineAvailable === false ? ' — busy' : ''}`} />
              </div>
            )}
          </section>
        )}

        {fac && (
          <section className="card">
            <h2 className="card-title">3 · Customer</h2>
            <CustomerPicker value={customer} onChange={setCustomer} />
          </section>
        )}

        {fac && (
          <section className="card">
            <h2 className="card-title">4 · Payment</h2>
            <div className="pick-grid">
              {[['pay_at_venue', 'Pay at venue'], ['cash', 'Cash received'], ['upi_offline', 'UPI received'], ['card_offline', 'Card received']].map(([v, l]) => (
                <button key={v} type="button" className={`pick ${form.paymentMode === v ? 'is-on' : ''}`} onClick={() => set('paymentMode')(v)}>{l}</button>
              ))}
            </div>
            <div className="form-grid cols-2 mt">
              <Field label="Amount" hint={quote?.price ? `Price list: ${money(quote.price.total)}` : quote?.priceError}>
                <RupeeInput value={form.amount} onChange={(v) => setForm((f) => ({ ...f, amount: v, amountTouched: true }))} required />
              </Field>
              <Field label="Notes (internal)"><input className="input" value={form.notes} onChange={(e) => set('notes')(e.target.value)} placeholder="e.g. Corporate team, needs bibs" /></Field>
            </div>
          </section>
        )}

        {fac && (
          <div className="row gap-sm">
            <Button type="submit" size="lg" loading={saving} disabled={noneFree || selectedResourceBusy} icon="check">Confirm booking</Button>
            <Button type="button" variant="ghost" onClick={() => window.history.back()}>Cancel</Button>
          </div>
        )}
      </div>
    </form>
  );
}
