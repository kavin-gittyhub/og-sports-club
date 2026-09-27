import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from '../lib/router.jsx';
import { useSession } from '../lib/auth.jsx';
import { Icon } from './Icons.jsx';

export function Logo({ light = false }) {
  const { config } = useSession();
  const name = config?.club?.name || 'OG Sports Club';
  return (
    <Link to="/" className={`logo ${light ? 'logo-light' : ''}`} aria-label={`${name} home`}>
      <svg width="34" height="34" viewBox="0 0 64 64" aria-hidden="true">
        <rect width="64" height="64" rx="16" fill="#0b2b20" />
        <circle cx="24" cy="32" r="11" fill="none" stroke="#b8f53b" strokeWidth="6" />
        <path d="M50 24h-8a8 8 0 0 0 0 16h8v-8h-6" fill="none" stroke="#fff" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="logo-text">{name}</span>
    </Link>
  );
}

function AccountMenu() {
  const { isSignedIn, displayName, imageUrl, signIn, signOut, openProfile, isAdmin, mode } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  if (!isSignedIn) {
    return <button className="btn btn-outline btn-sm" onClick={signIn}><Icon name="user" size={18} /><span>Sign in</span></button>;
  }
  const initial = (displayName || '?').trim().charAt(0).toUpperCase();
  return (
    <div className="account" ref={ref}>
      <button className="avatar-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label="Account menu">
        {imageUrl ? <img src={imageUrl} alt="" /> : <span>{initial}</span>}
      </button>
      {open && (
        <div className="menu" role="menu" onClick={() => setOpen(false)}>
          <div className="menu-head">Signed in as<br /><strong>{displayName}</strong></div>
          <Link className="menu-item" to="/my-bookings" role="menuitem"><Icon name="ticket" size={18} />My bookings</Link>
          {mode === 'clerk' && <button className="menu-item" role="menuitem" onClick={openProfile}><Icon name="user" size={18} />Profile</button>}
          {isAdmin && <Link className="menu-item" to="/admin" role="menuitem"><Icon name="shield" size={18} />Admin dashboard</Link>}
          <button className="menu-item" role="menuitem" onClick={signOut}><Icon name="logout" size={18} />Sign out</button>
        </div>
      )}
    </div>
  );
}

export function SiteHeader() {
  const { isSignedIn, isAdmin } = useSession();
  const { path } = useLocation();
  return (
    <header className="site-header">
      <div className="container header-inner">
        <Logo />
        <nav className="header-nav" aria-label="Main">
          <Link to="/book" className={path.startsWith('/book') ? 'active' : ''}>Book</Link>
          <a href="/#prices">Prices</a>
          <a href="/#contact">Contact</a>
          {isSignedIn && <Link to="/my-bookings" className={path === '/my-bookings' ? 'active' : ''}>My bookings</Link>}
          {isAdmin && <Link to="/admin">Admin</Link>}
        </nav>
        <div className="header-actions">
          {!path.startsWith('/book') && <Link to="/book" className="btn btn-primary btn-sm hide-sm">Book now</Link>}
          <AccountMenu />
        </div>
      </div>
    </header>
  );
}

/** Familiar app-style bottom navigation on phones. */
export function BottomNav() {
  const { path } = useLocation();
  const { isSignedIn, signIn } = useSession();
  if (path.startsWith('/book') || path.startsWith('/admin')) return null;
  const item = (to, icon, label, active) => (
    <Link to={to} className={`bottom-nav-item ${active ? 'active' : ''}`}><Icon name={icon} size={22} /><span>{label}</span></Link>
  );
  return (
    <nav className="bottom-nav" aria-label="Quick navigation">
      {item('/', 'home', 'Home', path === '/')}
      {item('/book', 'calendar', 'Book', false)}
      {isSignedIn
        ? item('/my-bookings', 'ticket', 'Bookings', path === '/my-bookings')
        : <button className="bottom-nav-item" onClick={signIn}><Icon name="user" size={22} /><span>Sign in</span></button>}
    </nav>
  );
}

export function SiteFooter() {
  const { config } = useSession();
  const c = config?.club || {};
  return (
    <footer className="site-footer">
      <div className="container footer-inner">
        <div>
          <Logo light />
          <p className="footer-tag">{c.tagline}</p>
        </div>
        <div className="footer-links">
          <Link to="/book">Book a slot</Link>
          <Link to="/my-bookings">My bookings</Link>
          <a href="/#prices">Prices</a>
          <a href="/#contact">Contact</a>
        </div>
        <div className="footer-contact">
          {c.phone && <a href={`tel:${c.phone.replace(/\s/g, '')}`}><Icon name="phone" size={16} />{c.phone}</a>}
          {c.email && <a href={`mailto:${c.email}`}><Icon name="mail" size={16} />{c.email}</a>}
          {c.address && <span><Icon name="mapPin" size={16} />{c.address}</span>}
        </div>
      </div>
      <div className="container footer-bottom">© {new Date().getFullYear()} {c.name || 'OG Sports Club'} · Secure payments by Razorpay</div>
    </footer>
  );
}
