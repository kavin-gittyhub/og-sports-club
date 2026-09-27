import { useState } from 'react';
import { api } from '../lib/api.js';
import { useSession } from '../lib/auth.jsx';
import { Link } from '../lib/router.jsx';
import { money, fmtDate, fmtRange, fmtDuration } from '../lib/format.js';
import { Icon } from '../components/Icons.jsx';
import { SportBadge } from '../components/SportArt.jsx';
import { Button, Empty, ErrorBox, Skeleton, StatusBadge, useAsync } from '../components/ui.jsx';
import { BookingActions } from '../components/BookingActions.jsx';

const TABS = [
  { id: 'upcoming', label: 'Upcoming', test: (b) => ['upcoming', 'in_progress', 'pending_payment'].includes(b.displayStatus) },
  { id: 'past', label: 'Past', test: (b) => b.displayStatus === 'completed' },
  { id: 'cancelled', label: 'Cancelled', test: (b) => ['cancelled', 'expired'].includes(b.displayStatus) },
];

function BookingCard({ b, club, onChange }) {
  return (
    <article className="booking-card">
      <Link to={`/booking/${b.id}`} className="booking-card-main">
        <SportBadge sport={b.facility.sport} />
        <div className="grow">
          <div className="row between center gap-sm">
            <h3>{b.facility.name}{b.quantity > 1 ? ` × ${b.quantity}` : ''}</h3>
            <StatusBadge status={b.displayStatus} />
          </div>
          <div className="booking-card-meta">
            <span><Icon name="calendar" size={16} />{fmtDate(b.date)}</span>
            <span><Icon name="clock" size={16} />{fmtRange(b.startMinute, b.endMinute)}</span>
          </div>
          <div className="booking-card-meta">
            <span className="muted">{fmtDuration(b.durationMin)}{b.quantity > 1 ? ` · ${b.quantity} ${b.facility.unitLabel}s` : ''}{b.bowlingMachine ? ' · Bowling machine' : ''}</span>
            <strong>{money(b.amounts.total)}</strong>
          </div>
        </div>
      </Link>
      {(b.canExtend || b.cancellation.allowed || b.displayStatus === 'pending_payment') && (
        <div className="booking-card-actions">
          <BookingActions booking={b} club={club} compact onChange={onChange} />
        </div>
      )}
    </article>
  );
}

export default function MyBookings() {
  const { isLoaded, isSignedIn, signIn, config } = useSession();
  const [tab, setTab] = useState('upcoming');
  const { data, loading, error, reload, setData } = useAsync(
    () => (isSignedIn ? api('/bookings') : Promise.resolve({ bookings: [] })),
    [isSignedIn]
  );

  if (isLoaded && !isSignedIn) {
    return (
      <main className="container page narrow">
        <Empty icon="ticket" title="Your bookings live here" action={<Button onClick={signIn}>Sign in to view</Button>}>
          Sign in to see, extend or cancel your bookings.
        </Empty>
      </main>
    );
  }

  const all = data?.bookings || [];
  const current = TABS.find((t) => t.id === tab);
  let list = all.filter(current.test);
  if (tab === 'upcoming') list = [...list].sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
  const onChange = (nb) => setData((d) => ({ bookings: d.bookings.map((x) => (x.id === nb.id ? nb : x)) }));

  return (
    <main className="container page narrow">
      <div className="row between center">
        <h1 className="page-title">My bookings</h1>
        <Link to="/book" className="btn btn-primary btn-sm"><Icon name="plus" size={18} />New</Link>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map((t) => {
          const count = all.filter(t.test).length;
          return (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id ? 'is-active' : ''}`} onClick={() => setTab(t.id)}>
              {t.label}{count > 0 && <span className="tab-count">{count}</span>}
            </button>
          );
        })}
      </div>
      <ErrorBox error={error} onRetry={reload} />
      <div className="stack">
        {loading && !data && Array.from({ length: 3 }, (_, i) => <Skeleton key={i} h={120} r={18} />)}
        {list.map((b) => <BookingCard key={b.id} b={b} club={config?.club} onChange={onChange} />)}
        {data && list.length === 0 && (
          <Empty
            icon={tab === 'cancelled' ? 'ban' : 'calendar'}
            title={tab === 'upcoming' ? 'No upcoming bookings' : tab === 'past' ? 'No past bookings yet' : 'No cancelled bookings'}
            action={tab === 'upcoming' ? <Link to="/book" className="btn btn-primary">Book a slot</Link> : null}
          >
            {tab === 'upcoming' ? 'Grab a slot — it only takes a minute.' : null}
          </Empty>
        )}
      </div>
    </main>
  );
}
