import { useEffect, useState } from 'react';
import { Link } from '../lib/router.jsx';
import { api } from '../lib/api.js';
import { useSession } from '../lib/auth.jsx';
import { money, fmtMin, fmtDays } from '../lib/format.js';
import { Icon } from '../components/Icons.jsx';
import { SportArt, sportColor } from '../components/SportArt.jsx';
import { Skeleton, ErrorBox, useAsync } from '../components/ui.jsx';

function FacilityCard({ f }) {
  return (
    <article className="facility-card">
      <Link to={`/book?facility=${f.slug}`} className="facility-card-media" aria-label={`Book ${f.name}`}>
        <SportArt sport={f.sport} imageUrl={f.imageUrl} alt={f.name} />
        {f.fromPricePerHour !== null && (
          <span className="price-pill">from <strong>{money(f.fromPricePerHour)}</strong>/hr</span>
        )}
      </Link>
      <div className="facility-card-body">
        <h3>{f.name}</h3>
        <p className="muted">{f.tagline}</p>
        <ul className="chips">
          {f.bowlingMachine && <li className="chip chip-accent"><Icon name="zap" size={14} />Bowling machine</li>}
          {(f.features || []).filter((x) => !/bowling/i.test(x)).slice(0, 3).map((x) => <li key={x} className="chip">{x}</li>)}
        </ul>
        <Link to={`/book?facility=${f.slug}`} className="btn btn-dark btn-block" style={{ '--accent': sportColor(f.sport) }}>
          Book {f.name} <Icon name="arrowRight" size={18} />
        </Link>
      </div>
    </article>
  );
}

function PriceTable({ slug }) {
  const [data, setData] = useState(null);
  useEffect(() => { api(`/facilities/${slug}`).then(setData).catch(() => {}); }, [slug]);
  if (!data) return <div className="price-card"><Skeleton h={22} w="50%" /><Skeleton h={14} className="mt" /><Skeleton h={14} className="mt-sm" /></div>;
  const f = data.facility;
  const rows = [...data.pricing].sort((a, b) => (a.days?.[0] ?? -1) - (b.days?.[0] ?? -1) || a.startMinute - b.startMinute);
  return (
    <div className="price-card">
      <div className="price-card-head">
        <span className="dot" style={{ background: sportColor(f.sport) }} />
        <h3>{f.name}</h3>
      </div>
      <table className="price-table">
        <tbody>
          {rows.map((r, i) => {
            const s = Math.max(r.startMinute, f.openMinute);
            const e = Math.min(r.endMinute, f.closeMinute);
            if (e <= s) return null;
            return (
              <tr key={i}>
                <td><strong>{r.label}</strong><br /><span className="muted small">{fmtDays(r.days)} · {fmtMin(s)} – {fmtMin(e)}</span></td>
                <td className="num"><strong>{money(r.pricePerHour)}</strong><span className="muted small">/hr</span></td>
              </tr>
            );
          })}
          {f.bowlingMachine && (
            <tr className="addon-row">
              <td><strong>Bowling machine</strong><br /><span className="muted small">Optional add-on</span></td>
              <td className="num"><strong>+{money(f.bowlingMachine.pricePerHour)}</strong><span className="muted small">/hr</span></td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="muted small">Open {fmtMin(f.openMinute)} – {fmtMin(f.closeMinute)} · Book from {f.durations[0]} min</p>
    </div>
  );
}

export default function Home() {
  const { config } = useSession();
  const club = config?.club || {};
  const policy = config?.policy || {};
  const { data, loading, error, reload } = useAsync(() => api('/facilities'), []);
  const facilities = data?.facilities || [];

  return (
    <main>
      <section className="hero">
        <div className="hero-bg" aria-hidden="true" />
        <div className="container hero-inner">
          <p className="eyebrow"><span className="pulse" /> Live availability · Instant confirmation</p>
          <h1>Book your game<br /><span className="hl">in seconds.</span></h1>
          <p className="hero-sub">{club.tagline || 'Floodlit turf, cricket nets and pickleball courts.'} Pick an activity, choose a time, pay with UPI. Done.</p>
          <div className="hero-cta">
            <Link to="/book" className="btn btn-primary btn-lg">Book now <Icon name="arrowRight" /></Link>
            <a href="#prices" className="btn btn-ghost-light btn-lg">View prices</a>
          </div>
          <ul className="trust">
            <li><Icon name="zap" size={18} />Instant confirmation</li>
            <li><Icon name="shield" size={18} />Secure UPI & card payments</li>
            {policy.cancellationCutoffHours !== undefined && <li><Icon name="refresh" size={18} />Free cancellation up to {policy.cancellationCutoffHours}h before</li>}
          </ul>
        </div>
      </section>

      <section className="section container" id="facilities" aria-labelledby="fac-title">
        <div className="section-head">
          <h2 id="fac-title">Choose your activity</h2>
          <p className="muted">Pick any start time that suits you — 7:30, 8:15, whenever. No fixed hourly slots.</p>
        </div>
        <ErrorBox error={error} onRetry={reload} />
        <div className="facility-grid">
          {loading && Array.from({ length: 4 }, (_, i) => (
            <div className="facility-card" key={i}><Skeleton h={180} r={0} /><div className="facility-card-body"><Skeleton h={22} w="60%" /><Skeleton h={14} className="mt-sm" /><Skeleton h={48} className="mt" r={12} /></div></div>
          ))}
          {facilities.map((f) => <FacilityCard key={f.slug} f={f} />)}
        </div>
      </section>

      <section className="section section-tint" aria-labelledby="how-title">
        <div className="container">
          <div className="section-head center">
            <h2 id="how-title">How it works</h2>
          </div>
          <ol className="steps-how">
            <li><span className="how-num">1</span><Icon name="target" size={28} /><h3>Pick activity & time</h3><p className="muted">See what’s free right now and choose any start time.</p></li>
            <li><span className="how-num">2</span><Icon name="card" size={28} /><h3>Pay securely</h3><p className="muted">UPI, cards or netbanking. Your slot is held while you pay.</p></li>
            <li><span className="how-num">3</span><Icon name="checkCircle" size={28} /><h3>Show up & play</h3><p className="muted">Instant confirmation. Manage or extend from My bookings.</p></li>
          </ol>
        </div>
      </section>

      <section className="section container" id="prices" aria-labelledby="price-title">
        <div className="section-head">
          <h2 id="price-title">Prices</h2>
          <p className="muted">Transparent hourly rates. You’ll see the exact total before you pay.</p>
        </div>
        <div className="price-grid">
          {facilities.map((f) => <PriceTable key={f.slug} slug={f.slug} />)}
        </div>
      </section>

      <section className="section container" id="contact" aria-labelledby="contact-title">
        <div className="contact-card">
          <div>
            <h2 id="contact-title">Visit us</h2>
            <p className="muted">{club.hours_note}</p>
            <ul className="contact-list">
              {club.address && <li><Icon name="mapPin" /><span>{club.address}{club.city ? `, ${club.city}` : ''}</span></li>}
              {club.phone && <li><Icon name="phone" /><a href={`tel:${club.phone.replace(/\s/g, '')}`}>{club.phone}</a></li>}
              {club.email && <li><Icon name="mail" /><a href={`mailto:${club.email}`}>{club.email}</a></li>}
            </ul>
          </div>
          <div className="contact-actions">
            {club.map_url && <a className="btn btn-dark btn-lg" href={club.map_url} target="_blank" rel="noopener noreferrer"><Icon name="mapPin" />Get directions</a>}
            {club.whatsapp && <a className="btn btn-whatsapp btn-lg" href={`https://wa.me/${club.whatsapp}`} target="_blank" rel="noopener noreferrer"><Icon name="message" />WhatsApp us</a>}
            {club.phone && <a className="btn btn-outline btn-lg" href={`tel:${club.phone.replace(/\s/g, '')}`}><Icon name="phone" />Call</a>}
          </div>
        </div>
      </section>

      <section className="cta-band">
        <div className="container cta-band-inner">
          <div>
            <h2>Ready to play?</h2>
            <p>It takes less than a minute.</p>
          </div>
          <Link to="/book" className="btn btn-primary btn-lg">Book now <Icon name="arrowRight" /></Link>
        </div>
      </section>
    </main>
  );
}
