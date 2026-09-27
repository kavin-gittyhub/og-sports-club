import { api } from '../lib/api.js';
import { useSession } from '../lib/auth.jsx';
import { Link, useQuery } from '../lib/router.jsx';
import { money, fmtDate, fmtMin, fmtDuration, PAYMENT_LABEL } from '../lib/format.js';
import { Icon } from '../components/Icons.jsx';
import { SportArt } from '../components/SportArt.jsx';
import { Button, ErrorBox, Skeleton, StatusBadge, Empty, useAsync } from '../components/ui.jsx';
import { BookingActions } from '../components/BookingActions.jsx';

export default function BookingDetail({ id }) {
  const { isLoaded, isSignedIn, signIn, config } = useSession();
  const isNew = useQuery().get('new') === '1';
  const { data, loading, error, reload, setData } = useAsync(
    () => (isSignedIn ? api(`/bookings/${id}`) : Promise.resolve(null)),
    [id, isSignedIn]
  );
  const b = data?.booking;

  if (isLoaded && !isSignedIn) {
    return (
      <main className="container page narrow">
        <Empty icon="lock" title="Sign in to view this booking" action={<Button onClick={signIn}>Sign in</Button>} />
      </main>
    );
  }

  const confirmed = b && ['upcoming', 'in_progress', 'completed'].includes(b.displayStatus);
  return (
    <main className="container page narrow">
      <ErrorBox error={error} onRetry={reload} />
      {loading && !b && (
        <div className="card"><Skeleton h={64} w={64} r={32} /><Skeleton h={28} w="60%" className="mt" /><Skeleton h={180} className="mt" /></div>
      )}
      {b && (
        <>
          {isNew && confirmed && (
            <div className="success-hero" role="status">
              <div className="success-check"><Icon name="check" size={40} strokeWidth={3} /></div>
              <h1>Booking Confirmed</h1>
              <p className="muted">You’re all set! We’ve saved this in <Link to="/my-bookings">My bookings</Link>.</p>
            </div>
          )}
          {!isNew && <Link to="/my-bookings" className="back-link"><Icon name="arrowLeft" size={18} />My bookings</Link>}
          {b.displayStatus === 'pending_payment' && (
            <div className="alert alert-hold"><Icon name="timer" /><div className="grow">Payment pending — complete payment to confirm this booking.</div></div>
          )}
          {b.status === 'cancelled' && b.amounts.refund > 0 && (
            <div className="alert alert-info"><Icon name="info" /><div className="grow">Refund of <strong>{money(b.amounts.refund)}</strong> — {PAYMENT_LABEL[b.paymentStatus]?.toLowerCase()}. Refunds reach your account in 5–7 working days.</div></div>
          )}

          <article className="ticket">
            <div className="ticket-media"><SportArt sport={b.facility.sport} alt="" /></div>
            <div className="ticket-body">
              <div className="row between center">
                <h2>{b.facility.name}</h2>
                <StatusBadge status={b.displayStatus} />
              </div>
              <dl className="ticket-grid">
                <div><dt>Booking ID</dt><dd className="mono">{b.ref}</dd></div>
                <div><dt>Activity</dt><dd>{b.facility.name}{b.quantity > 1 ? ` × ${b.quantity} ${b.facility.unitLabel}s` : ''}{b.bowlingMachine ? ' + Bowling machine' : ''}</dd></div>
                <div><dt>Date</dt><dd>{fmtDate(b.date, { year: 'numeric' })}</dd></div>
                <div><dt>Time</dt><dd><span className="nowrap">{fmtMin(b.startMinute)}</span> – <span className="nowrap">{fmtMin(b.endMinute)}</span></dd></div>
                <div><dt>Duration</dt><dd>{fmtDuration(b.durationMin)}</dd></div>
                <div><dt>Amount</dt><dd>{money(b.amounts.total)} <span className="muted small">· {PAYMENT_LABEL[b.paymentStatus]}</span></dd></div>
              </dl>
              {b.amounts.extension > 0 && <p className="muted small">Includes {money(b.amounts.extension)} for extra time.</p>}
            </div>
            <div className="ticket-foot">
              <BookingActions booking={b} club={config?.club} onChange={(nb) => setData({ booking: nb })} />
            </div>
          </article>

          <div className="row gap-sm wrap mt-lg center-x">
            <Link to="/book" className="btn btn-primary">Book another</Link>
            <Link to="/my-bookings" className="btn btn-outline">My bookings</Link>
          </div>
          {config?.club?.phone && (
            <p className="muted small center mt">Questions? Call <a href={`tel:${config.club.phone.replace(/\s/g, '')}`}>{config.club.phone}</a></p>
          )}
        </>
      )}
    </main>
  );
}
