import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useSession } from '../lib/auth.jsx';
import { navigate, useQuery, Link } from '../lib/router.jsx';
import { pay, PaymentDismissed } from '../lib/payments.js';
import { money, fmtMin, fmtRange, fmtRangeShort, fmtDuration, fmtDate, addDays } from '../lib/format.js';
import { Icon } from '../components/Icons.jsx';
import { SportArt, sportColor } from '../components/SportArt.jsx';
import { DateStrip, MonthCalendar } from '../components/Calendar.jsx';
import { Button, Spinner, Skeleton, ErrorBox, Empty, Modal, useToast, useConfirm, Field } from '../components/ui.jsx';

const DRAFT_KEY = 'og_booking_draft';
const readDraft = () => { try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null'); } catch { return null; } };
const writeDraft = (d) => { try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { /* ignore */ } };
const clearDraft = () => { try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ } };

const PERIODS = [
  { key: 'morning', label: 'Morning', icon: 'sun', test: (m) => m < 720 },
  { key: 'afternoon', label: 'Afternoon', icon: 'sunset', test: (m) => m >= 720 && m < 1020 },
  { key: 'evening', label: 'Evening', icon: 'moon', test: (m) => m >= 1020 },
];

// ───────────────────────────────────────────────── helpers

function useCountdown(iso) {
  const [left, setLeft] = useState(() => (iso ? new Date(iso) - Date.now() : 0));
  useEffect(() => {
    if (!iso) return undefined;
    const t = setInterval(() => setLeft(new Date(iso) - Date.now()), 1000);
    return () => clearInterval(t);
  }, [iso]);
  const s = Math.max(0, Math.floor(left / 1000));
  return { seconds: s, label: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` };
}

function StepHeader({ steps, index, onBack }) {
  const step = steps[index];
  return (
    <div className="step-header">
      <div className="step-header-row">
        {index > 0 ? (
          <button className="icon-btn icon-btn-lg" onClick={onBack} aria-label="Back"><Icon name="arrowLeft" /></button>
        ) : (
          <Link to="/" className="icon-btn icon-btn-lg" aria-label="Close"><Icon name="x" /></Link>
        )}
        <div className="grow">
          <div className="step-count">Step {index + 1} of {steps.length}</div>
          <h1 className="step-title">{step.title}</h1>
        </div>
      </div>
      <div className="progress" role="progressbar" aria-valuemin={1} aria-valuemax={steps.length} aria-valuenow={index + 1}>
        {steps.map((s, i) => <span key={s.id} className={i <= index ? 'is-done' : ''} />)}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────── steps

function ActivityStep({ facilities, loading, error, reload, value, onPick }) {
  return (
    <div className="step-body">
      <ErrorBox error={error} onRetry={reload} />
      <div className="activity-list">
        {loading && Array.from({ length: 4 }, (_, i) => <Skeleton key={i} h={92} r={18} />)}
        {facilities.map((f) => (
          <button
            key={f.slug}
            className={`activity-option ${value === f.slug ? 'is-selected' : ''}`}
            onClick={() => onPick(f.slug)}
            aria-pressed={value === f.slug}
            style={{ '--accent': sportColor(f.sport) }}
          >
            <span className="activity-thumb"><SportArt sport={f.sport} imageUrl={f.imageUrl} alt="" /></span>
            <span className="activity-text">
              <strong>{f.name}</strong>
              <span className="muted small">{f.tagline}</span>
              {f.fromPricePerHour !== null && <span className="activity-price">from {money(f.fromPricePerHour)}/hr</span>}
            </span>
            <Icon name="chevronRight" className="activity-chevron" />
          </button>
        ))}
      </div>
    </div>
  );
}

function DateStep({ today, facility, value, onPick }) {
  const [showCal, setShowCal] = useState(false);
  const maxDate = addDays(today, facility?.advanceBookingDays ?? 30);
  return (
    <div className="step-body">
      <DateStrip today={today} value={value} onChange={onPick} days={14} maxDate={maxDate} />
      <button className="link-btn mt" onClick={() => setShowCal((s) => !s)} aria-expanded={showCal}>
        <Icon name="calendar" size={18} /> {showCal ? 'Hide calendar' : 'Pick another date'}
      </button>
      {showCal && (
        <div className="card mt">
          <MonthCalendar today={today} value={value} onChange={onPick} minDate={today} maxDate={maxDate} />
        </div>
      )}
      <p className="muted small mt">You can book up to {facility?.advanceBookingDays ?? 30} days ahead.</p>
    </div>
  );
}

const plural = (word, n) => (n === 1 ? word : `${word}s`);
/** How many units are free for the whole duration from this start (anonymous counts only). */
const freeFor = (s, duration) => (s.status === 'available' ? (s.runs ? s.runs.filter((r) => r >= duration).length : s.maxDuration >= duration ? 1 : 0) : 0);

function TimeStep({ facility, date, today, duration, setDuration, quantity, setQuantity, start, setStart, avail, availLoading, availError, reloadAvail, lastUpdated, onPickDate }) {
  const [showAll, setShowAll] = useState(false);
  const interval = facility.slotIntervalMin;
  const close = avail?.closeMinute ?? facility.closeMinute;
  // Hide past times and starts that would run past closing for the chosen duration.
  const slots = (avail?.slots || []).filter((s) => s.status !== 'past' && s.minute + duration <= close);
  const canUse = (s) => freeFor(s, duration) >= quantity;
  const unit = facility.unitLabel || 'unit';
  const visible = slots.filter((s) => showAll || interval >= 30 || s.minute % 30 === 0 || s.minute === start);
  const availableCount = slots.filter(canUse).length;
  const hiddenAvailable = slots.filter((s) => canUse(s) && !visible.includes(s)).length;

  return (
    <div className="step-body">
      <div className="date-pill-row">
        <button className="date-pill" onClick={() => onPickDate()}>
          <Icon name="calendar" size={16} /> {fmtDate(date)} <span className="muted">· change</span>
        </button>
      </div>

      <h2 className="sub-title">How long?</h2>
      <div className="seg" role="radiogroup" aria-label="Duration">
        {facility.durations.map((d) => (
          <button key={d} role="radio" aria-checked={duration === d} className={`seg-btn ${duration === d ? 'is-selected' : ''}`} onClick={() => setDuration(d)}>
            {fmtDuration(d)}
          </button>
        ))}
      </div>

      {facility.maxQuantity > 1 && (
        <>
          <h2 className="sub-title">How many {plural(unit, 2)}?</h2>
          <div className="seg" role="radiogroup" aria-label={`Number of ${plural(unit, 2)}`}>
            {Array.from({ length: facility.maxQuantity }, (_, i) => i + 1).map((n) => (
              <button key={n} role="radio" aria-checked={quantity === n} className={`seg-btn ${quantity === n ? 'is-selected' : ''}`} onClick={() => setQuantity(n)}>
                {n} {plural(unit, n)}
              </button>
            ))}
          </div>
          {quantity > 1 && <p className="muted small mt-sm">You’ll get {quantity} {plural(unit, quantity)} side by side for the same time — we assign them for you.</p>}
        </>
      )}

      <div className="row between center mt-lg">
        <h2 className="sub-title no-mt">Start time</h2>
        <span className="muted small live-note">
          {availLoading ? <Spinner size={12} /> : <span className="pulse pulse-sm" />} Live{lastUpdated ? ` · updated ${lastUpdated}` : ''}
        </span>
      </div>

      <div className="legend" aria-hidden="true">
        <span><i className="lg lg-free" />Available</span>
        <span><i className="lg lg-booked" />Booked</span>
        <span><i className="lg lg-blocked" />Unavailable</span>
      </div>

      <ErrorBox error={availError} onRetry={reloadAvail} />
      {!avail && availLoading && <div className="time-grid">{Array.from({ length: 12 }, (_, i) => <Skeleton key={i} h={52} r={12} />)}</div>}

      {avail?.closedReason && <Empty icon="calendar" title="Not available">{avail.closedReason}</Empty>}

      {avail && !avail.closedReason && availableCount === 0 && (
        <Empty
          icon="calendar"
          title={slots.length ? (quantity > 1 ? `No time with ${quantity} ${plural(unit, quantity)} free` : 'Fully booked for this duration') : date === today ? 'No more slots today' : 'No slots'}
          action={
            <div className="row gap-sm wrap center-x">
              {quantity > 1 && <Button variant="outline" onClick={() => setQuantity(quantity - 1)}>Try {quantity - 1} {plural(unit, quantity - 1)}</Button>}
              {facility.durations[0] < duration && <Button variant="outline" onClick={() => setDuration(facility.durations[0])}>Try {fmtDuration(facility.durations[0])}</Button>}
              <Button variant="primary" onClick={() => onPickDate(addDays(date, 1))}>Try {fmtDate(addDays(date, 1))}</Button>
            </div>
          }
        >
          Try a shorter duration or another date.
        </Empty>
      )}

      {avail && !avail.closedReason && availableCount > 0 && PERIODS.map((p) => {
        const list = visible.filter((s) => p.test(s.minute));
        if (!list.length) return null;
        return (
          <section key={p.key} className="period">
            <h3 className="period-title"><Icon name={p.icon} size={16} />{p.label}</h3>
            <div className="time-grid">
              {list.map((s) => {
                const ok = canUse(s);
                const selected = start === s.minute;
                const free = freeFor(s, duration);
                const partial = !ok && free > 0;
                const cls = ok ? '' : partial ? 'is-partial' : s.status === 'blocked' ? 'is-blocked' : 'is-booked';
                return (
                  <button
                    key={s.minute}
                    className={`time-chip ${cls} ${selected ? 'is-selected' : ''}`}
                    disabled={!ok}
                    aria-pressed={selected}
                    aria-label={`${fmtMin(s.minute)}${ok ? '' : partial ? `, only ${free} ${plural(unit, free)} free` : s.status === 'blocked' ? ', unavailable' : ', booked'}`}
                    onClick={() => setStart(s.minute)}
                  >
                    <span className="time-chip-main">{fmtMin(s.minute)}</span>
                    {selected && <span className="time-chip-sub">to {fmtMin(s.minute + duration)}</span>}
                    {!ok && !selected && <span className="time-chip-sub">{partial ? `Only ${free} free` : s.status === 'blocked' ? 'Unavailable' : 'Booked'}</span>}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}

      {avail && interval < 30 && availableCount > 0 && (
        <button className="link-btn mt" onClick={() => setShowAll((x) => !x)}>
          <Icon name={showAll ? 'minus' : 'plus'} size={18} />
          {showAll ? 'Show fewer start times' : `Show every ${interval} minutes${hiddenAvailable ? ` (+${hiddenAvailable} more)` : ''}`}
        </button>
      )}
    </div>
  );
}

function ExtrasStep({ facility, bowling, setBowling, quote, quantity = 1 }) {
  const price = facility.bowlingMachine?.pricePerHour ?? 0;
  const machineFree = quote?.bowlingMachineAvailable !== false;
  return (
    <div className="step-body">
      <div className="addon-card">
        <div className="addon-head">
          <span className="addon-icon"><Icon name="zap" size={22} /></span>
          <div>
            <h2 className="sub-title no-mt">Bowling machine</h2>
            <p className="muted small">Consistent deliveries for focused batting practice. {money(price)}/hr.</p>
          </div>
        </div>
        <div className="radio-cards" role="radiogroup" aria-label="Bowling machine">
          <button role="radio" aria-checked={!bowling} className={`radio-card ${!bowling ? 'is-selected' : ''}`} onClick={() => setBowling(false)}>
            <span className="radio-dot" /> <span className="grow">No</span>
          </button>
          <button
            role="radio" aria-checked={bowling} disabled={!machineFree}
            className={`radio-card ${bowling ? 'is-selected' : ''}`} onClick={() => setBowling(true)}
          >
            <span className="radio-dot" />
            <span className="grow">Yes</span>
            <strong>+{money(quote?.price && bowling ? quote.price.addon : Math.round((price * (quote?.durationMin || 60)) / 60))}</strong>
          </button>
        </div>
        {!machineFree && <p className="field-error mt-sm">The bowling machine is already booked at this time.</p>}
        {quantity > 1 && <p className="muted small mt-sm">One bowling machine for your booking — move it between your nets as you like.</p>}
      </div>
    </div>
  );
}

function SummaryCard({ facility, date, start, duration, quantity, bowling, quote }) {
  const unit = facility.unitLabel || 'unit';
  return (
    <div className="summary-card">
      <div className="summary-media"><SportArt sport={facility.sport} imageUrl={facility.imageUrl} alt="" /></div>
      <div className="summary-body">
        <h2>{facility.name}{quantity > 1 ? ` × ${quantity}` : ''}</h2>
        <dl className="summary-list">
          <div><dt><Icon name="calendar" size={18} />Date</dt><dd>{fmtDate(date, { year: 'numeric' })}</dd></div>
          <div><dt><Icon name="clock" size={18} />Time</dt><dd>{fmtRange(start, start + duration)}</dd></div>
          <div><dt><Icon name="timer" size={18} />Duration</dt><dd>{fmtDuration(duration)}</dd></div>
          {facility.maxQuantity > 1 && <div><dt><Icon name="grid" size={18} />{plural(unit, 2).replace(/^./, (c) => c.toUpperCase())}</dt><dd>{quantity} {plural(unit, quantity)}</dd></div>}
          {facility.bowlingMachine && <div><dt><Icon name="zap" size={18} />Bowling machine</dt><dd>{bowling ? 'Yes' : 'No'}</dd></div>}
        </dl>
        <div className="summary-price">
          {quote?.price ? (
            <>
              {quote.price.breakdown.map((b, i) => (
                <div key={i} className="row between small muted"><span>{b.label} · {fmtDuration(b.minutes)} × {money(b.pricePerHour)}/hr{quantity > 1 ? ` × ${quantity} ${plural(unit, quantity)}` : ''}</span><span>{money(Math.round((b.pricePerHour * b.minutes) / 60) * quantity)}</span></div>
              ))}
              {quote.price.addon > 0 && <div className="row between small muted"><span>Bowling machine · {fmtDuration(duration)}</span><span>{money(quote.price.addon)}</span></div>}
              <div className="row between total"><span>Total</span><strong>{money(quote.price.total)}</strong></div>
            </>
          ) : <Skeleton h={28} />}
        </div>
      </div>
    </div>
  );
}

function MockPayDialog({ checkout, onResult }) {
  return (
    <Modal
      open={Boolean(checkout)}
      onClose={() => onResult(false)}
      title="Test payment"
      size="sm"
      footer={<><Button variant="ghost" onClick={() => onResult(false)}>Cancel</Button><Button onClick={() => onResult(true)} icon="check">Pay {money(checkout?.amount)}</Button></>}
    >
      <div className="alert alert-info"><Icon name="info" /><div>Development mode — no real money is charged. In production this opens Razorpay with UPI, cards and netbanking.</div></div>
      <p className="mt"><strong>{checkout?.description}</strong></p>
    </Modal>
  );
}

// ───────────────────────────────────────────────── page

export default function Book() {
  const toast = useToast();
  const confirm = useConfirm();
  const { config, isSignedIn, signIn, me, refreshMe } = useSession();
  const today = config?.today;
  const q = useQuery();

  const [facilities, setFacilities] = useState([]);
  const [facLoading, setFacLoading] = useState(true);
  const [facError, setFacError] = useState(null);
  const loadFacilities = useCallback(() => {
    setFacLoading(true); setFacError(null);
    api('/facilities').then((d) => setFacilities(d.facilities)).catch(setFacError).finally(() => setFacLoading(false));
  }, []);
  useEffect(loadFacilities, [loadFacilities]);

  const draft = useRef(readDraft()).current;
  const [slug, setSlug] = useState(() => q.get('facility') || draft?.slug || null);
  const [date, setDate] = useState(() => draft?.date || null);
  const [duration, setDuration] = useState(() => draft?.duration || null);
  const [quantity, setQuantity] = useState(() => draft?.quantity || 1);
  const [start, setStart] = useState(() => draft?.start ?? null);
  const [bowling, setBowling] = useState(() => Boolean(draft?.bowling));
  const [stepId, setStepId] = useState(() => (q.get('facility') ? 'date' : draft?.stepId || 'activity'));
  const [phone, setPhone] = useState('');
  const [phoneError, setPhoneError] = useState('');

  const facility = facilities.find((f) => f.slug === slug) || null;
  const steps = useMemo(() => [
    { id: 'activity', title: 'Choose your activity' },
    { id: 'date', title: 'Choose a date' },
    { id: 'time', title: 'Choose a time' },
    ...(facility?.bowlingMachine ? [{ id: 'extras', title: 'Add-ons' }] : []),
    { id: 'review', title: config?.paymentProvider === 'venue' ? 'Review & book' : 'Review & pay' },
  ], [facility, config?.paymentProvider]);
  const index = Math.max(0, steps.findIndex((s) => s.id === stepId));
  const go = (id) => { setStepId(id); window.scrollTo({ top: 0 }); };

  // Keep state sane when facility/date change.
  useEffect(() => {
    if (!facility) return;
    if (!duration || !facility.durations.includes(duration)) setDuration(facility.durations.includes(60) ? 60 : facility.durations[0]);
    if (!facility.bowlingMachine && bowling) setBowling(false);
    if (quantity > facility.maxQuantity) setQuantity(1);
  }, [facility]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (today && (!date || date < today)) setDate(today); }, [today]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!facilities.length) return; if (slug && !facility) { setSlug(null); go('activity'); } }, [facilities]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (stepId !== 'activity' && !slug) setStepId('activity'); }, [stepId, slug]);
  useEffect(() => { if (['extras', 'review'].includes(stepId) && start === null) setStepId('time'); }, [stepId, start]);
  useEffect(() => { writeDraft({ slug, date, duration, quantity, start, bowling, stepId }); }, [slug, date, duration, quantity, start, bowling, stepId]);

  // ── live availability
  const [avail, setAvail] = useState(null);
  const [availLoading, setAvailLoading] = useState(false);
  const [availError, setAvailError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState('');
  const availKey = slug && date ? `${slug}|${date}` : null;
  const loadAvail = useCallback(async ({ silent = false } = {}) => {
    if (!availKey) return;
    const [s, d] = availKey.split('|');
    if (!silent) { setAvailLoading(true); setAvailError(null); }
    try {
      const data = await api(`/facilities/${s}/availability?date=${d}`);
      setAvail({ ...data, key: availKey });
      setLastUpdated(new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }));
    } catch (e) {
      if (!silent) setAvailError(e);
    } finally {
      setAvailLoading(false);
    }
  }, [availKey]);
  useEffect(() => { setAvail(null); if (stepId === 'time' || stepId === 'review' || stepId === 'extras') loadAvail(); }, [availKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (stepId !== 'time') return undefined;
    if (!avail || avail.key !== availKey) loadAvail();
    const t = setInterval(() => { if (document.visibilityState === 'visible') loadAvail({ silent: true }); }, 20_000);
    const onVis = () => { if (document.visibilityState === 'visible') loadAvail({ silent: true }); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [stepId, availKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // If the chosen start stops being valid (someone else booked / duration changed), clear it.
  useEffect(() => {
    if (start === null || !avail || avail.key !== availKey) return;
    const s = avail.slots.find((x) => x.minute === start);
    if (!s || freeFor(s, duration) < quantity) {
      setStart(null);
      if (stepId === 'time') toast.info(quantity > 1 ? `That time doesn’t have ${quantity} free — please pick another.` : 'That time is no longer available for this duration — please pick another.');
    }
  }, [avail, duration, quantity]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── quote (server-calculated price)
  const [quote, setQuote] = useState(null);
  useEffect(() => {
    setQuote(null);
    if (!slug || !date || start === null || !duration) return undefined;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      api('/quote', { method: 'POST', body: { facility: slug, date, startMinute: start, durationMin: duration, bowlingMachine: bowling, quantity }, signal: ctl.signal })
        .then((d) => setQuote({ ...d, durationMin: duration }))
        .catch(() => {});
    }, 120);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [slug, date, start, duration, bowling, quantity]);
  useEffect(() => { if (bowling && quote && quote.bowlingMachineAvailable === false) setBowling(false); }, [quote]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── payment
  const [paying, setPaying] = useState(false);
  const [pending, setPending] = useState(null); // { booking, checkout }
  const [mockCheckout, setMockCheckout] = useState(null);
  const mockResolver = useRef(null);
  const mockPay = (checkout) => new Promise((resolve) => { mockResolver.current = resolve; setMockCheckout(checkout); });
  const wantPay = useRef(false);
  const countdown = useCountdown(pending?.booking?.holdExpiresAt);

  const runPayment = async (checkout) => {
    try {
      const result = await pay(checkout, { mockPay });
      clearDraft();
      if (result.outcome === 'slot_lost') {
        toast.error('Sorry — the slot was taken while you were paying. A full refund has been issued.');
      }
      navigate(`/booking/${result.booking.id}?new=1`);
    } catch (err) {
      if (err instanceof PaymentDismissed || err.code === 'DISMISSED') {
        toast.info('Payment not completed. Your slot is held for a few minutes.');
      } else {
        toast.error(err.message);
      }
    }
  };

  const proceed = async () => {
    if (!isSignedIn) { wantPay.current = true; signIn(); return; }
    const needPhone = me && !me.phone;
    const cleanPhone = phone.replace(/\s/g, '');
    if (needPhone && cleanPhone && !/^[+\d][\d-]{6,18}$/.test(cleanPhone)) { setPhoneError('Please enter a valid phone number'); return; }
    setPhoneError('');
    setPaying(true);
    try {
      if (pending && pending.booking.status === 'pending_payment' && countdown.seconds > 0) {
        const { checkout } = await api(`/bookings/${pending.booking.id}/pay`, { method: 'POST' });
        await runPayment(checkout);
      } else {
        const res = await api('/bookings', {
          method: 'POST',
          body: { facility: slug, date, startMinute: start, durationMin: duration, bowlingMachine: bowling, quantity, phone: cleanPhone || undefined },
        });
        if (cleanPhone) refreshMe();
        if (!res.checkout) {
          // Pay-at-venue mode: the booking is already confirmed.
          clearDraft();
          navigate(`/booking/${res.booking.id}?new=1`);
          return;
        }
        setPending(res);
        await runPayment(res.checkout);
      }
    } catch (err) {
      if (err.status === 409) {
        toast.error(err.message);
        setStart(null);
        go('time');
        loadAvail();
      } else if (err.code === 'HOLD_EXPIRED') {
        setPending(null);
        toast.error(err.message);
      } else {
        toast.error(err.message);
      }
    } finally {
      setPaying(false);
    }
  };
  useEffect(() => {
    if (isSignedIn && wantPay.current && stepId === 'review') { wantPay.current = false; proceed(); }
  }, [isSignedIn]); // eslint-disable-line react-hooks/exhaustive-deps

  const releaseHold = async () => {
    if (!pending) return;
    const ok = await confirm({ title: 'Change your selection?', message: 'We’ll release the slot we’re holding for you.', confirmText: 'Yes, change' });
    if (!ok) return;
    api(`/bookings/${pending.booking.id}/cancel`, { method: 'POST', body: { reason: 'Changed selection' } }).catch(() => {});
    setPending(null);
    go('time');
  };
  const pendingMatches = pending && pending.booking.date === date && pending.booking.startMinute === start && pending.booking.durationMin === duration && pending.booking.facility.slug === slug && pending.booking.bowlingMachine === bowling && pending.booking.quantity === quantity;
  useEffect(() => { if (pending && !pendingMatches) setPending(null); }, [pendingMatches]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── navigation
  const next = () => go(steps[Math.min(index + 1, steps.length - 1)].id);
  const back = () => { if (pending) { releaseHold(); return; } go(steps[Math.max(0, index - 1)].id); };
  const pickFacility = (s) => {
    if (s !== slug) { setStart(null); setBowling(false); setAvail(null); setQuantity(1); }
    setSlug(s);
    go('date');
  };
  const pickDate = (d) => {
    if (d !== date) setStart(null);
    setDate(d);
    go('time');
  };

  if (!today) return <div className="page-loader"><Spinner size={28} /></div>;

  const bottomSummary = facility && start !== null
    ? `${fmtDate(date, { weekday: undefined })} · ${fmtRangeShort(start, start + duration)}${quantity > 1 ? ` · ${quantity} ${plural(facility.unitLabel || 'unit', quantity)}` : ''}`
    : facility && date ? `${facility.name} · ${fmtDate(date)}` : null;

  return (
    <main className="booking">
      <div className="booking-shell">
        <StepHeader steps={steps} index={index} onBack={back} />

        {stepId === 'activity' && (
          <ActivityStep facilities={facilities} loading={facLoading} error={facError} reload={loadFacilities} value={slug} onPick={pickFacility} />
        )}
        {stepId === 'date' && facility && <DateStep today={today} facility={facility} value={date} onPick={pickDate} />}
        {stepId === 'time' && facility && (
          <TimeStep
            facility={facility} date={date} today={today} duration={duration} setDuration={setDuration}
            quantity={quantity} setQuantity={setQuantity}
            start={start} setStart={setStart} avail={avail?.key === availKey ? avail : null} availLoading={availLoading}
            availError={availError} reloadAvail={() => loadAvail()} lastUpdated={lastUpdated}
            onPickDate={(d) => (d ? pickDate(d) : go('date'))}
          />
        )}
        {stepId === 'extras' && facility?.bowlingMachine && (
          <ExtrasStep facility={facility} bowling={bowling} setBowling={setBowling} quote={quote} quantity={quantity} />
        )}
        {stepId === 'review' && facility && start !== null && (
          <div className="step-body">
            {pendingMatches && countdown.seconds > 0 && (
              <div className="alert alert-hold" role="status">
                <Icon name="timer" />
                <div className="grow">We’re holding this slot for you for <strong>{countdown.label}</strong>. Complete payment to confirm.</div>
              </div>
            )}
            <SummaryCard facility={facility} date={date} start={start} duration={duration} quantity={quantity} bowling={bowling} quote={quote} />
            {isSignedIn && me && !me.phone && (
              <Field label="Mobile number" hint="For booking updates and UPI. Optional." error={phoneError} className="mt">
                <input className="input" inputMode="tel" autoComplete="tel" placeholder="98765 43210" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </Field>
            )}
            <ul className="assurances">
              {config?.paymentProvider === 'venue'
                ? <li><Icon name="rupee" size={18} />Pay at the club — cash or UPI at the counter</li>
                : <li><Icon name="shield" size={18} />Secure payment via Razorpay — UPI, cards, netbanking</li>}
              <li><Icon name="refresh" size={18} />Free cancellation up to {config?.policy?.cancellationCutoffHours ?? 4} hours before start</li>
              <li><Icon name="clock" size={18} />Need more time? Extend from My bookings if the next slot is free</li>
            </ul>
            {quote && !quote.available && (
              <div className="alert alert-error mt"><Icon name="alert" /><div className="grow">This time was just booked. <button className="link-btn" onClick={() => { setStart(null); go('time'); loadAvail(); }}>Pick another time</button></div></div>
            )}
          </div>
        )}
      </div>

      {stepId !== 'activity' && stepId !== 'date' && (
        <div className="bottom-bar">
          <div className="bottom-bar-inner">
            <div className="bottom-bar-info">
              {bottomSummary && <span className="bottom-bar-sum">{bottomSummary}</span>}
              <strong className="bottom-bar-price">{quote?.price ? money(quote.price.total) : start !== null ? <Spinner size={14} /> : 'Select a time'}</strong>
            </div>
            {stepId === 'review' ? (
              <Button size="lg" onClick={proceed} loading={paying} disabled={!quote?.available} iconRight="arrowRight">
                {config?.paymentProvider === 'venue' ? (isSignedIn ? 'Confirm Booking' : 'Sign in to book') : isSignedIn ? 'Proceed to Payment' : 'Sign in to pay'}
              </Button>
            ) : (
              <Button size="lg" onClick={next} disabled={start === null || (stepId === 'time' && !quote)} iconRight="arrowRight">Continue</Button>
            )}
          </div>
        </div>
      )}

      <MockPayDialog checkout={mockCheckout} onResult={(ok) => { setMockCheckout(null); mockResolver.current?.(ok); }} />
    </main>
  );
}
