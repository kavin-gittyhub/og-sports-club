import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { Button, ErrorBox, Field, Spinner, useToast } from '../../components/ui.jsx';
import { PageHead } from './shared.jsx';

function ClubForm({ initial, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onSaved(await api('/admin/settings/club', { method: 'PUT', body: f })); toast.success('Club details saved'); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <form className="card" onSubmit={save}>
      <h2 className="card-title">Club details</h2>
      <p className="muted small">Shown on the home page, footer and payment screen.</p>
      <ErrorBox error={error} />
      <div className="form-grid cols-2">
        <Field label="Club name"><input className="input" required value={f.name} onChange={set('name')} /></Field>
        <Field label="Tagline"><input className="input" value={f.tagline} onChange={set('tagline')} /></Field>
        <Field label="Address" className="span-2"><input className="input" value={f.address} onChange={set('address')} /></Field>
        <Field label="City"><input className="input" value={f.city} onChange={set('city')} /></Field>
        <Field label="Opening hours note"><input className="input" value={f.hours_note} onChange={set('hours_note')} placeholder="Open daily · 6 AM – 12 AM" /></Field>
        <Field label="Phone"><input className="input" value={f.phone} onChange={set('phone')} /></Field>
        <Field label="Email"><input className="input" type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="WhatsApp number" hint="Digits with country code, e.g. 919876543210"><input className="input" inputMode="numeric" value={f.whatsapp} onChange={set('whatsapp')} /></Field>
        <Field label="Google Maps link" hint="https://maps.app.goo.gl/…"><input className="input" value={f.map_url} onChange={set('map_url')} /></Field>
      </div>
      <Button type="submit" loading={busy} icon="check" className="mt">Save club details</Button>
    </form>
  );
}

function PolicyForm({ initial, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const num = (k) => (e) => setF((x) => ({ ...x, [k]: Number(e.target.value) }));
  const toggleExt = (m) => setF((x) => ({ ...x, extension_options: x.extension_options.includes(m) ? x.extension_options.filter((y) => y !== m) : [...x.extension_options, m].sort((a, b) => a - b) }));
  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onSaved(await api('/admin/settings/booking_policy', { method: 'PUT', body: f })); toast.success('Booking policy saved'); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <form className="card" onSubmit={save}>
      <h2 className="card-title">Booking policy</h2>
      <ErrorBox error={error} />
      <div className="form-grid cols-3">
        <Field label="Hold slot while paying (min)" hint="Released automatically if unpaid."><input className="input" type="number" min="3" max="30" value={f.hold_minutes} onChange={num('hold_minutes')} /></Field>
        <Field label="Free cancellation until (hours before)"><input className="input" type="number" min="0" max="168" value={f.cancellation_cutoff_hours} onChange={num('cancellation_cutoff_hours')} /></Field>
        <Field label="Refund on cancellation (%)"><input className="input" type="number" min="0" max="100" value={f.refund_percent} onChange={num('refund_percent')} /></Field>
      </div>
      <Field label="Extension options customers can buy" className="mt">
        <div className="day-picks">
          {[15, 30, 45, 60, 90, 120].map((m) => (
            <button key={m} type="button" className={`day-pick ${f.extension_options.includes(m) ? 'is-on' : ''}`} style={{ minWidth: 72 }} onClick={() => toggleExt(m)}>+{m >= 60 ? `${m / 60} hr` : `${m} min`}</button>
          ))}
        </div>
      </Field>
      <Button type="submit" loading={busy} icon="check" className="mt">Save policy</Button>
    </form>
  );
}

export default function Settings() {
  const [s, setS] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api('/admin/settings').then(setS).catch(setError); }, []);
  return (
    <>
      <PageHead title="Settings" />
      <ErrorBox error={error} />
      {!s && !error && <Spinner />}
      {s && (
        <div className="stack">
          <ClubForm initial={s.club} onSaved={setS} />
          <PolicyForm initial={s.booking_policy} onSaved={setS} />
        </div>
      )}
    </>
  );
}
