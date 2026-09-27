import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { navigate } from '../../lib/router.jsx';
import { useSession } from '../../lib/auth.jsx';
import { fmtMin, fmtDate, addDays, money } from '../../lib/format.js';
import { Icon } from '../../components/Icons.jsx';
import { sportColor } from '../../components/SportArt.jsx';
import { Button, ErrorBox, Spinner, useAsync } from '../../components/ui.jsx';
import { PageHead } from './shared.jsx';
import { BookingDrawer } from './BookingDrawer.jsx';

const PX = 1.15; // pixels per minute

function nowMinuteInClub(tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return (+p.hour % 24) * 60 + +p.minute;
}

export default function Timetable() {
  const { config } = useSession();
  const today = config?.today;
  const [date, setDate] = useState(() => new URLSearchParams(window.location.search).get('date') || today);
  const { data, loading, error, reload } = useAsync(() => (date ? api(`/admin/timetable?date=${date}`) : Promise.resolve(null)), [date]);
  const [openId, setOpenId] = useState(null);
  const wrapRef = useRef(null);
  const [nowMin, setNowMin] = useState(() => nowMinuteInClub(config?.timezone || 'Asia/Kolkata'));

  useEffect(() => { if (!date && today) setDate(today); }, [today, date]);
  useEffect(() => {
    const t = setInterval(() => { setNowMin(nowMinuteInClub(config?.timezone || 'Asia/Kolkata')); reload({ silent: true }); }, 60_000);
    return () => clearInterval(t);
  }, [reload, config]);
  useEffect(() => { if (date) window.history.replaceState({}, '', `/admin/timetable?date=${date}`); }, [date]);

  const start = data ? Math.floor(data.minMinute / 60) * 60 : 360;
  const end = data ? Math.ceil(data.maxMinute / 60) * 60 : 1440;
  const H = (end - start) * PX;
  const y = (m) => (Math.max(start, Math.min(end, m)) - start) * PX;

  // Scroll to "now" (or first booking) when the data first arrives.
  const scrolled = useRef(null);
  useEffect(() => {
    if (!data || scrolled.current === date || !wrapRef.current) return;
    scrolled.current = date;
    const target = date === today ? nowMin - 60 : (data.bookings[0]?.startMinute ?? start) - 30;
    wrapRef.current.scrollTop = Math.max(0, y(target));
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const columns = data ? data.facilities.flatMap((f) => f.resources.map((r) => ({ f, r }))) : [];
  const hours = [];
  for (let m = start; m <= end; m += 30) hours.push(m);

  const onColClick = (e, f, r) => {
    if (e.target.closest('.tt-item')) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const minute = Math.floor((start + (e.clientY - rect.top) / PX) / 15) * 15;
    navigate(`/admin/bookings/new?facility=${f.id}&resource=${r.id}&date=${date}&start=${minute}`);
  };

  return (
    <>
      <PageHead title="Timetable" sub="Every internal net and court at a glance. Tap an empty space to add a booking.">
        <Button variant="primary" size="sm" icon="plus" onClick={() => navigate(`/admin/bookings/new?date=${date}`)}>New booking</Button>
      </PageHead>
      <div className="tt-toolbar">
        <div className="tt-date">
          <button className="icon-btn" onClick={() => setDate(addDays(date, -1))} aria-label="Previous day"><Icon name="chevronLeft" /></button>
          <input type="date" value={date || ''} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Date" />
          <button className="icon-btn" onClick={() => setDate(addDays(date, 1))} aria-label="Next day"><Icon name="chevronRight" /></button>
        </div>
        {date !== today && <Button variant="outline" size="sm" onClick={() => setDate(today)}>Today</Button>}
        <strong>{date && fmtDate(date, { year: 'numeric' })}</strong>
        {loading && <Spinner size={16} />}
        <div className="tt-legend" style={{ marginLeft: 'auto' }}>
          {data?.facilities.map((f) => <span key={f.id}><i className="dot" style={{ background: sportColor(f.sport) }} />{f.name}</span>)}
          <span><i className="lg lg-blocked" />Blocked</span>
          <span><i className="lg" style={{ background: 'repeating-linear-gradient(45deg,#94a39b 0 3px,#cbd5d0 3px 6px)' }} />Awaiting payment</span>
        </div>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {data && (
        <div className="tt-wrap" ref={wrapRef}>
          <div className="tt" style={{ gridTemplateColumns: `60px repeat(${columns.length}, minmax(124px, 1fr))` }}>
            <div className="tt-corner" />
            {columns.map(({ f, r }) => (
              <div key={r.id} className="tt-colhead" style={{ borderTop: `4px solid ${sportColor(f.sport)}` }}>
                <div className="tt-fac" style={{ color: sportColor(f.sport) }}>{f.name}</div>
                <div className="tt-res">{r.name}</div>
              </div>
            ))}
            <div className="tt-times" style={{ height: H, position: 'sticky' }}>
              {hours.filter((m) => m % 60 === 0).map((m) => <span key={m} className="tt-time" style={{ top: y(m) }}>{m === 1440 ? '12 AM' : fmtMin(m).replace(':00', '')}</span>)}
            </div>
            {columns.map(({ f, r }) => {
              const bookings = data.bookings.filter((b) => (b.resources || [b.resource]).some((x) => x.id === r.id));
              const blocks = data.blocks.filter((b) => b.resourceId === r.id);
              const color = sportColor(f.sport);
              return (
                <div key={r.id} className="tt-col is-closed" style={{ height: H }} onClick={(e) => onColClick(e, f, r)} role="presentation">
                  <div className="tt-open" style={{ top: y(f.openMinute), height: y(f.closeMinute) - y(f.openMinute) }} />
                  {hours.map((m) => <div key={m} className={`tt-hour ${m % 60 ? 'half' : ''}`} style={{ top: y(m) }} />)}
                  {blocks.map((bl, i) => (
                    <div key={i} className="tt-block" style={{ top: y(bl.startMinute), height: Math.max(8, y(bl.endMinute) - y(bl.startMinute)) }}>Blocked</div>
                  ))}
                  {bookings.map((b) => (
                    <button
                      key={b.id}
                      className={`tt-item ${b.status === 'pending_payment' ? 'is-pending' : ''}`}
                      style={{ top: y(b.startMinute) + 1, height: Math.max(22, y(b.endMinute) - y(b.startMinute) - 2), background: color }}
                      onClick={() => setOpenId(b.id)}
                      title={`${b.customer.name} · ${fmtMin(b.startMinute)}–${fmtMin(b.endMinute)} · ${money(b.amounts.total)}`}
                    >
                      <strong>{b.customer.name || 'Customer'}{b.quantity > 1 ? ` ×${b.quantity}` : ''}</strong>
                      {fmtMin(b.startMinute)} – {fmtMin(b.endMinute)}
                      {b.bowlingMachine && <span className="tt-flag" title="Bowling machine"><Icon name="zap" size={13} /></span>}
                      {b.status === 'pending_payment' && <div>Awaiting payment</div>}
                      {b.paymentStatus === 'pay_at_venue' && <div>Pay at venue</div>}
                    </button>
                  ))}
                  {date === today && nowMin >= start && nowMin <= end && <div className="tt-now" style={{ top: y(nowMin) }} />}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {data && columns.length === 0 && <p className="muted">No active facilities.</p>}
      <BookingDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => reload({ silent: true })} />
    </>
  );
}
