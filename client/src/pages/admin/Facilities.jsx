import { useState } from 'react';
import { api } from '../../lib/api.js';
import { money, fmtDuration, rupeesToPaise, paiseToRupees } from '../../lib/format.js';
import { Icon } from '../../components/Icons.jsx';
import { SportArt } from '../../components/SportArt.jsx';
import { Button, ErrorBox, Field, Modal, Toggle, Skeleton, useToast, Badge } from '../../components/ui.jsx';
import { PageHead, TimeSelect, RupeeInput, useAdminFacilities, invalidateFacilities } from './shared.jsx';

const SPORTS = [['football', 'Football turf'], ['oval', 'Oval / box cricket'], ['cricket', 'Cricket nets'], ['pickleball', 'Pickleball'], ['badminton', 'Badminton'], ['tennis', 'Tennis'], ['basketball', 'Basketball'], ['other', 'Other']];

function Resources({ facility, onChanged }) {
  const toast = useToast();
  const [names, setNames] = useState(() => Object.fromEntries(facility.resources.map((r) => [r.id, r.name])));
  const [newName, setNewName] = useState('');
  const update = async (r, body) => {
    try {
      const res = await api(`/admin/resources/${r.id}`, { method: 'PATCH', body });
      if (body.isActive === false && res.futureBookings > 0) toast.info(`${r.name} deactivated. ${res.futureBookings} future booking(s) still assigned to it — move them in the timetable.`);
      else toast.success('Saved');
      onChanged();
    } catch (e) { toast.error(e.message); }
  };
  const add = async () => {
    if (!newName.trim()) return;
    try { await api(`/admin/facilities/${facility.id}/resources`, { method: 'POST', body: { name: newName.trim() } }); setNewName(''); toast.success('Added'); onChanged(); } catch (e) { toast.error(e.message); }
  };
  return (
    <div className="resource-list">
      {facility.resources.map((r) => (
        <div key={r.id} className="resource-item">
          <input className="input" value={names[r.id] ?? r.name} onChange={(e) => setNames((n) => ({ ...n, [r.id]: e.target.value }))} onBlur={() => names[r.id] && names[r.id] !== r.name && update(r, { name: names[r.id] })} aria-label="Resource name" />
          <Toggle checked={r.isActive} onChange={(v) => update(r, { isActive: v })} label={r.isActive ? 'Active' : 'Off'} />
        </div>
      ))}
      <div className="row gap-sm">
        <input className="input" placeholder={`e.g. ${facility.resources.length ? facility.resources[0].name.replace(/\w$/, 'D') : 'Court A'}`} value={newName} onChange={(e) => setNewName(e.target.value)} />
        <Button variant="outline" icon="plus" onClick={add}>Add</Button>
      </div>
      <p className="muted small">Customers only see “{facility.name}”. Bookings are auto-assigned to any active unit that’s free.</p>
    </div>
  );
}

function FacilityEditor({ facility, onChanged }) {
  const toast = useToast();
  const [f, setF] = useState(() => ({
    name: facility.name, tagline: facility.tagline, description: facility.description, sport: facility.sport, imageUrl: facility.imageUrl || '',
    features: (facility.features || []).join(', '), openMinute: facility.openMinute, closeMinute: facility.closeMinute,
    slotIntervalMin: facility.slotIntervalMin, minDurationMin: facility.minDurationMin, maxDurationMin: facility.maxDurationMin,
    durationStepMin: facility.durationStepMin, advanceBookingDays: facility.advanceBookingDays, minLeadMinutes: facility.minLeadMinutes,
    supportsBowlingMachine: facility.supportsBowlingMachine, bowlingMachinePrice: paiseToRupees(facility.bowlingMachinePricePerHour),
    bowlingMachineUnits: facility.bowlingMachineUnits, isActive: facility.isActive,
    unitLabel: facility.unitLabel || 'unit', maxUnitsPerBooking: facility.maxUnitsPerBooking || 0,
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const num = (k) => (e) => set(k)(Number(e.target.value));

  const durations = [];
  for (let d = f.minDurationMin; d <= f.maxDurationMin && d <= f.closeMinute - f.openMinute && durations.length < 20; d += Math.max(5, f.durationStepMin)) durations.push(d);

  const save = async () => {
    setSaving(true); setError(null);
    try {
      await api(`/admin/facilities/${facility.id}`, {
        method: 'PATCH',
        body: {
          name: f.name, tagline: f.tagline, description: f.description, sport: f.sport, imageUrl: f.imageUrl,
          features: f.features.split(',').map((x) => x.trim()).filter(Boolean), openMinute: f.openMinute, closeMinute: f.closeMinute,
          slotIntervalMin: f.slotIntervalMin, minDurationMin: f.minDurationMin, maxDurationMin: f.maxDurationMin, durationStepMin: f.durationStepMin,
          advanceBookingDays: f.advanceBookingDays, minLeadMinutes: f.minLeadMinutes, isActive: f.isActive,
          unitLabel: f.unitLabel, maxUnitsPerBooking: f.maxUnitsPerBooking,
          ...(facility.supportsBowlingMachine || f.supportsBowlingMachine ? { supportsBowlingMachine: f.supportsBowlingMachine, bowlingMachinePricePerHour: rupeesToPaise(f.bowlingMachinePrice), bowlingMachineUnits: f.bowlingMachineUnits } : {}),
        },
      });
      toast.success(`${f.name} saved`);
      invalidateFacilities();
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card">
      <div className="row gap wrap">
        <div style={{ width: 120, height: 68, borderRadius: 12, overflow: 'hidden', flex: 'none' }}><SportArt sport={f.sport} imageUrl={f.imageUrl} alt="" /></div>
        <div className="grow">
          <h2 className="card-title" style={{ margin: 0 }}>{facility.name} {!facility.isActive && <Badge>Hidden</Badge>}</h2>
          <div className="muted small">{facility.resources.filter((r) => r.isActive).length} active unit(s) · from {facility.pricing.length ? money(Math.min(...facility.pricing.map((p) => p.pricePerHour))) : "—"}/hr · {facility.durations.map(fmtDuration).join(', ')}</div>
        </div>
        <Button variant={open ? 'ghost' : 'outline'} icon={open ? 'chevronDown' : 'edit'} onClick={() => setOpen((o) => !o)}>{open ? 'Close' : 'Edit'}</Button>
      </div>
      {open && (
        <div className="stack mt">
          <ErrorBox error={error} />
          <h3 className="sub-title no-mt">Customer-facing details</h3>
          <div className="form-grid cols-2">
            <Field label="Name"><input className="input" value={f.name} onChange={(e) => set('name')(e.target.value)} /></Field>
            <Field label="Illustration">
              <select className="select" value={f.sport} onChange={(e) => set('sport')(e.target.value)}>{SPORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </Field>
            <Field label="Tagline" className="span-2"><input className="input" value={f.tagline} onChange={(e) => set('tagline')(e.target.value)} maxLength={120} /></Field>
            <Field label="Description" className="span-2"><textarea className="textarea" value={f.description} onChange={(e) => set('description')(e.target.value)} maxLength={1000} /></Field>
            <Field label="Features (comma separated)" className="span-2"><input className="input" value={f.features} onChange={(e) => set('features')(e.target.value)} /></Field>
            <Field label="Photo URL (optional, https)" hint="Leave empty to use the built-in illustration." className="span-2"><input className="input" value={f.imageUrl} onChange={(e) => set('imageUrl')(e.target.value)} placeholder="https://…" /></Field>
          </div>

          <h3 className="sub-title">Opening hours & booking rules</h3>
          <div className="form-grid cols-3">
            <Field label="Opens"><TimeSelect value={f.openMinute} onChange={set('openMinute')} step={15} /></Field>
            <Field label="Closes"><TimeSelect value={f.closeMinute} onChange={set('closeMinute')} step={15} from={15} to={1440} includeEnd /></Field>
            <Field label="Start times every" hint="e.g. 15 → 7:00, 7:15, 7:30…">
              <select className="select" value={f.slotIntervalMin} onChange={num('slotIntervalMin')}>{[5, 10, 15, 20, 30, 60].map((x) => <option key={x} value={x}>{x} minutes</option>)}</select>
            </Field>
            <Field label="Minimum duration (min)"><input className="input" type="number" min="15" step="5" value={f.minDurationMin} onChange={num('minDurationMin')} /></Field>
            <Field label="Maximum duration (min)"><input className="input" type="number" min="15" step="5" value={f.maxDurationMin} onChange={num('maxDurationMin')} /></Field>
            <Field label="Duration step (min)"><input className="input" type="number" min="5" step="5" value={f.durationStepMin} onChange={num('durationStepMin')} /></Field>
            <Field label="Book up to (days ahead)"><input className="input" type="number" min="0" max="365" value={f.advanceBookingDays} onChange={num('advanceBookingDays')} /></Field>
            <Field label="Minimum notice (min)" hint="0 = can book right up to start"><input className="input" type="number" min="0" step="5" value={f.minLeadMinutes} onChange={num('minLeadMinutes')} /></Field>
          </div>
          <p className="muted small">Customers can choose: {durations.length ? durations.map(fmtDuration).join(' · ') : '—'}</p>

          {(facility.supportsBowlingMachine || f.sport === 'cricket') && (
            <>
              <h3 className="sub-title">Bowling machine add-on</h3>
              <Toggle checked={f.supportsBowlingMachine} onChange={set('supportsBowlingMachine')} label="Offer bowling machine with this facility" />
              {f.supportsBowlingMachine && (
                <div className="form-grid cols-2">
                  <Field label="Price per hour"><RupeeInput value={f.bowlingMachinePrice} onChange={set('bowlingMachinePrice')} /></Field>
                  <Field label="Machines available" hint="Limits how many nets can use a machine at the same time."><input className="input" type="number" min="0" max="20" value={f.bowlingMachineUnits} onChange={num('bowlingMachineUnits')} /></Field>
                </div>
              )}
            </>
          )}

          <h3 className="sub-title">Internal units (hidden from customers)</h3>
          <div className="form-grid cols-2">
            <Field label="What customers call one unit" hint="Used in “How many nets?” — e.g. net, court"><input className="input" value={f.unitLabel} onChange={(e) => set('unitLabel')(e.target.value)} maxLength={20} /></Field>
            <Field label="Max units in one booking" hint="0 = customers can book all units at once"><input className="input" type="number" min="0" max="50" value={f.maxUnitsPerBooking} onChange={num('maxUnitsPerBooking')} /></Field>
          </div>
          <Resources facility={facility} onChanged={onChanged} />

          <div className="row gap wrap mt">
            <Toggle checked={f.isActive} onChange={set('isActive')} label="Visible & bookable" />
            <Button onClick={save} loading={saving} icon="check" className="mt-sm">Save {f.name}</Button>
          </div>
        </div>
      )}
    </section>
  );
}

function AddFacility({ open, onClose, onCreated }) {
  const toast = useToast();
  const [f, setF] = useState({ name: '', sport: 'badminton', resourceCount: 1, resourcePrefix: 'Court', price: 500, openMinute: 360, closeMinute: 1380 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      await api('/admin/facilities', {
        method: 'POST',
        body: { name: f.name, sport: f.sport, resourceCount: Number(f.resourceCount), resourcePrefix: f.resourcePrefix, pricePerHour: rupeesToPaise(f.price), openMinute: f.openMinute, closeMinute: f.closeMinute, minDurationMin: 60, maxDurationMin: 180, durationStepMin: 30, slotIntervalMin: 15 },
      });
      toast.success('Facility created');
      invalidateFacilities();
      onCreated();
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Add facility" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={busy} disabled={f.name.length < 2}>Create</Button></>}>
      <ErrorBox error={error} />
      <div className="form-grid cols-2">
        <Field label="Name" className="span-2"><input className="input" value={f.name} onChange={(e) => set('name')(e.target.value)} placeholder="e.g. Badminton" /></Field>
        <Field label="Type"><select className="select" value={f.sport} onChange={(e) => set('sport')(e.target.value)}>{SPORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <Field label="Price per hour"><RupeeInput value={f.price} onChange={set('price')} /></Field>
        <Field label="Number of units"><input className="input" type="number" min="1" max="20" value={f.resourceCount} onChange={(e) => set('resourceCount')(e.target.value)} /></Field>
        <Field label="Unit name" hint="Court → Court A, Court B…"><input className="input" value={f.resourcePrefix} onChange={(e) => set('resourcePrefix')(e.target.value)} /></Field>
        <Field label="Opens"><TimeSelect value={f.openMinute} onChange={set('openMinute')} /></Field>
        <Field label="Closes"><TimeSelect value={f.closeMinute} onChange={set('closeMinute')} from={15} to={1440} includeEnd /></Field>
      </div>
    </Modal>
  );
}

export default function Facilities() {
  const { facilities, loading, error, reload } = useAdminFacilities();
  const [adding, setAdding] = useState(false);
  return (
    <>
      <PageHead title="Facilities" sub="What customers can book, opening hours, time rules and internal nets/courts.">
        <Button variant="outline" size="sm" icon="plus" onClick={() => setAdding(true)}>Add facility</Button>
      </PageHead>
      <ErrorBox error={error} onRetry={reload} />
      <div className="stack">
        {loading && !facilities && Array.from({ length: 4 }, (_, i) => <Skeleton key={i} h={100} r={20} />)}
        {facilities?.map((f) => <FacilityEditor key={`${f.id}-${f.resources.length}`} facility={f} onChanged={reload} />)}
      </div>
      <div className="alert alert-info mt"><Icon name="info" /><div>Prices are managed on the <a href="/admin/pricing">Pricing</a> page.</div></div>
      <AddFacility open={adding} onClose={() => setAdding(false)} onCreated={reload} />
    </>
  );
}
