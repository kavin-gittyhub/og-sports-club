import { useState } from 'react';
import { api } from '../../lib/api.js';
import { Link } from '../../lib/router.jsx';
import { money, fmtDate, fmtRange, weekdayShort } from '../../lib/format.js';
import { Icon } from '../../components/Icons.jsx';
import { SportBadge, sportColor } from '../../components/SportArt.jsx';
import { ErrorBox, Skeleton, StatusBadge, PaymentBadge, useAsync, Empty } from '../../components/ui.jsx';
import { PageHead } from './shared.jsx';
import { BookingDrawer } from './BookingDrawer.jsx';

export default function Dashboard() {
  const { data: d, loading, error, reload } = useAsync(() => api('/admin/dashboard'), []);
  const [openId, setOpenId] = useState(null);
  const maxWeek = Math.max(1, ...(d?.week || []).map((w) => w.revenue));

  return (
    <>
      <PageHead title="Dashboard" sub={d ? fmtDate(d.today, { year: 'numeric' }) : ' '}>
        <Link to="/admin/timetable" className="btn btn-outline btn-sm"><Icon name="calendar" size={18} />Timetable</Link>
        <Link to="/admin/bookings/new" className="btn btn-primary btn-sm"><Icon name="plus" size={18} />New booking</Link>
      </PageHead>
      <ErrorBox error={error} onRetry={reload} />

      {d && d.refundsPending > 0 && (
        <div className="alert alert-warn"><Icon name="alert" /><div className="grow">{d.refundsPending} refund{d.refundsPending > 1 ? 's are' : ' is'} pending. <Link to="/admin/payments">Review payments</Link></div></div>
      )}

      <div className="kpis">
        {loading && !d ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} h={104} r={20} />) : d && (
          <>
            <div className="kpi kpi-dark">
              <div className="kpi-label"><Icon name="ticket" size={16} />Today’s bookings</div>
              <div className="kpi-value">{d.todayBookings}</div>
              <div className="kpi-sub">{d.liveNow} playing right now</div>
            </div>
            <div className="kpi">
              <div className="kpi-label"><Icon name="rupee" size={16} />Today’s revenue</div>
              <div className="kpi-value">{money(d.todayRevenue)}</div>
              <div className="kpi-sub">{d.todayPayments} payment{d.todayPayments === 1 ? '' : 's'} received</div>
            </div>
            <div className="kpi">
              <div className="kpi-label"><Icon name="calendar" size={16} />Booked value today</div>
              <div className="kpi-value">{money(d.todayBookedValue)}</div>
              <div className="kpi-sub">{d.payAtVenue} to collect at venue</div>
            </div>
            <div className="kpi">
              <div className="kpi-label"><Icon name="clock" size={16} />Upcoming</div>
              <div className="kpi-value">{d.upcoming.length}{d.upcoming.length === 10 ? '+' : ''}</div>
              <div className="kpi-sub">{d.activeHolds} checkout{d.activeHolds === 1 ? '' : 's'} in progress</div>
            </div>
          </>
        )}
      </div>

      <div className="dash-grid">
        <section className="card">
          <h2 className="card-title"><Icon name="clock" size={20} />Upcoming bookings</h2>
          {d && d.upcoming.length === 0 && <Empty icon="calendar" title="Nothing upcoming">New bookings will appear here.</Empty>}
          {d?.upcoming.map((b) => (
            <button key={b.id} className="list-row" onClick={() => setOpenId(b.id)}>
              <SportBadge sport={b.facility.sport} size={40} />
              <div className="grow">
                <div className="cell-strong">{b.customer.name || 'Customer'} <span className="resource-tag">{b.resource.name}</span></div>
                <div className="cell-sub">{b.facility.name} · {fmtDate(b.date)} · {fmtRange(b.startMinute, b.endMinute)}</div>
              </div>
              <div className="num">
                <div className="cell-strong">{money(b.amounts.total)}</div>
                {b.displayStatus === 'in_progress' ? <StatusBadge status="in_progress" /> : <PaymentBadge status={b.paymentStatus} />}
              </div>
            </button>
          ))}
          <Link to="/admin/bookings" className="link-btn mt">All bookings <Icon name="arrowRight" size={16} /></Link>
        </section>

        <div className="stack">
          <section className="card">
            <h2 className="card-title"><Icon name="chart" size={20} />Facility utilisation today</h2>
            {d?.utilization.map((u) => (
              <div key={u.id} className="util-row">
                <div className="row between">
                  <strong>{u.name}</strong>
                  <span className="muted small">{u.bookings} booking{u.bookings === 1 ? '' : 's'} · {Math.round((u.bookedMinutes / 60) * 10) / 10} hrs · <strong className="num">{u.percent}%</strong></span>
                </div>
                <div className="bar"><span style={{ width: `${Math.min(100, u.percent)}%`, background: sportColor(u.sport) }} /></div>
                <span className="cell-sub">{u.resources} internal {u.resources === 1 ? 'unit' : 'units'}</span>
              </div>
            ))}
          </section>
          <section className="card">
            <h2 className="card-title"><Icon name="rupee" size={20} />Revenue · last 7 days</h2>
            <div className="mini-chart">
              {d?.week.map((w) => (
                <div key={w.date} className={`mini-chart-col ${w.date === d.today ? 'is-today' : ''}`} title={`${fmtDate(w.date)}: ${money(w.revenue)}`}>
                  <span className="mini-chart-val">{w.revenue ? money(w.revenue).replace('₹', '') : ''}</span>
                  <div className="mini-chart-bar" style={{ height: `${(w.revenue / maxWeek) * 100}%` }} />
                  <span className="mini-chart-label">{weekdayShort(w.date)}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
      <BookingDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => reload({ silent: true })} />
    </>
  );
}
