import { useState } from 'react';
import { api, download } from '../../lib/api.js';
import { useSession } from '../../lib/auth.jsx';
import { money, fmtDate, addDays, fmtMin } from '../../lib/format.js';
import { Icon } from '../../components/Icons.jsx';
import { Button, ErrorBox, Field, Skeleton, useAsync } from '../../components/ui.jsx';
import { PageHead } from './shared.jsx';

const METHOD_LABEL = { cash: 'Cash', upi_offline: 'UPI (desk)', card_offline: 'Card (desk)' };

export default function Reports() {
  const { config } = useSession();
  const today = config?.today;
  const monthStart = today ? today.slice(0, 8) + '01' : '';
  const [range, setRange] = useState({ from: today ? addDays(today, -29) : '', to: today || '' });
  const { data: r, loading, error, reload } = useAsync(() => (range.from ? api(`/admin/reports?from=${range.from}&to=${range.to}`) : Promise.resolve(null)), [range.from, range.to]);
  const presets = [
    ['Last 7 days', addDays(today, -6), today],
    ['Last 30 days', addDays(today, -29), today],
    ['This month', monthStart, today],
    ['Last 90 days', addDays(today, -89), today],
  ];
  const maxDay = Math.max(1, ...(r?.byDay || []).map((d) => d.revenue));
  const maxFac = Math.max(1, ...(r?.byFacility || []).map((f) => f.value));
  const maxMethod = Math.max(1, ...(r?.byMethod || []).map((m) => m.revenue));
  const maxHour = Math.max(1, ...(r?.byHour || []).map((h) => h.bookings));

  return (
    <>
      <PageHead title="Reports" sub={r ? `${fmtDate(r.from)} – ${fmtDate(r.to)}` : ' '}>
        <Button variant="outline" size="sm" icon="download" onClick={() => download(`/admin/reports/bookings.csv?from=${range.from}&to=${range.to}`, `bookings_${range.from}_${range.to}.csv`)}>Export bookings (CSV)</Button>
      </PageHead>
      <div className="row gap-sm wrap" style={{ marginBottom: 12 }}>
        {today && presets.map(([label, from, to]) => (
          <button key={label} className={`fac-tab ${range.from === from && range.to === to ? 'is-active' : ''}`} onClick={() => setRange({ from, to })}>{label}</button>
        ))}
      </div>
      <div className="toolbar">
        <Field label="From"><input className="input" type="date" value={range.from} onChange={(e) => setRange((x) => ({ ...x, from: e.target.value }))} /></Field>
        <Field label="To"><input className="input" type="date" value={range.to} onChange={(e) => setRange((x) => ({ ...x, to: e.target.value }))} /></Field>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      <div className="kpis">
        {loading && !r ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} h={104} r={20} />) : r && (
          <>
            <div className="kpi kpi-dark"><div className="kpi-label"><Icon name="rupee" size={16} />Net revenue</div><div className="kpi-value">{money(r.totals.net)}</div><div className="kpi-sub">{money(r.totals.gross)} gross · {money(r.totals.refunds)} refunded</div></div>
            <div className="kpi"><div className="kpi-label"><Icon name="ticket" size={16} />Bookings</div><div className="kpi-value">{r.totals.bookings}</div><div className="kpi-sub">{r.totals.cancelled} cancelled</div></div>
            <div className="kpi"><div className="kpi-label"><Icon name="clock" size={16} />Hours played</div><div className="kpi-value">{r.totals.hours}</div><div className="kpi-sub">across all facilities</div></div>
            <div className="kpi"><div className="kpi-label"><Icon name="zap" size={16} />Bowling machine</div><div className="kpi-value">{r.totals.bowlingMachine}</div><div className="kpi-sub">bookings with add-on</div></div>
          </>
        )}
      </div>
      {r && (
        <div className="stack">
          <section className="card">
            <h2 className="card-title">Revenue by day</h2>
            <div className="chart-days" role="img" aria-label="Revenue per day">
              {r.byDay.map((d) => <div key={d.date} style={{ height: `${(d.revenue / maxDay) * 100}%` }} title={`${fmtDate(d.date)}: ${money(d.revenue)}`} />)}
            </div>
            <div className="chart-days-x"><span>{fmtDate(r.from)}</span><span>{fmtDate(r.to)}</span></div>
          </section>
          <div className="dash-grid">
            <section className="card">
              <h2 className="card-title">By facility</h2>
              <div className="table-wrap" style={{ boxShadow: 'none' }}>
                <table className="table">
                  <thead><tr><th>Facility</th><th className="num">Bookings</th><th className="num">Hours</th><th className="num">Value</th></tr></thead>
                  <tbody>
                    {r.byFacility.map((f) => (
                      <tr key={f.id}>
                        <td><div className="cell-strong">{f.name}</div><div className="bar mt-sm"><span style={{ width: `${(f.value / maxFac) * 100}%`, background: 'var(--brand-2)' }} /></div></td>
                        <td className="num">{f.bookings}</td>
                        <td className="num">{f.hours}</td>
                        <td className="num cell-strong">{money(f.value)}{f.addons > 0 && <div className="cell-sub">incl. {money(f.addons)} add-ons</div>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <div className="stack">
              <section className="card">
                <h2 className="card-title">By payment method</h2>
                <div className="hbars">
                  {r.byMethod.length === 0 && <p className="muted">No payments.</p>}
                  {r.byMethod.map((m) => (
                    <div key={m.method} className="hbar">
                      <span className="hbar-label">{METHOD_LABEL[m.method] || m.method.replace('Online · ', 'Online · ').replace('upi', 'UPI')}</span>
                      <div className="bar"><span style={{ width: `${(m.revenue / maxMethod) * 100}%`, background: 'var(--green)' }} /></div>
                      <strong className="num">{money(m.revenue)}</strong>
                    </div>
                  ))}
                </div>
              </section>
              <section className="card">
                <h2 className="card-title">Busiest start times</h2>
                <div className="hbars">
                  {r.byHour.length === 0 && <p className="muted">No bookings.</p>}
                  {r.byHour.map((h) => (
                    <div key={h.hour} className="hbar">
                      <span className="hbar-label">{fmtMin(h.hour * 60)}</span>
                      <div className="bar"><span style={{ width: `${(h.bookings / maxHour) * 100}%`, background: 'var(--amber)' }} /></div>
                      <strong className="num">{h.bookings}</strong>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
