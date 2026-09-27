import { useState } from 'react';
import { useSession } from '../../lib/auth.jsx';
import { Link, Routes, useLocation } from '../../lib/router.jsx';
import { Icon } from '../../components/Icons.jsx';
import { Logo } from '../../components/Layout.jsx';
import { Button, Empty, Spinner } from '../../components/ui.jsx';
import Dashboard from './Dashboard.jsx';
import Timetable from './Timetable.jsx';
import BookingsList from './BookingsList.jsx';
import NewBooking from './NewBooking.jsx';
import Blocks from './Blocks.jsx';
import Facilities from './Facilities.jsx';
import Pricing from './Pricing.jsx';
import Customers from './Customers.jsx';
import Payments from './Payments.jsx';
import Reports from './Reports.jsx';
import Settings from './Settings.jsx';
import Audit from './Audit.jsx';

const NAV = [
  { group: 'Overview' },
  { to: '/admin', icon: 'grid', label: 'Dashboard', exact: true },
  { to: '/admin/timetable', icon: 'calendar', label: 'Timetable' },
  { to: '/admin/bookings', icon: 'list', label: 'Bookings' },
  { to: '/admin/bookings/new', icon: 'plus', label: 'New booking' },
  { group: 'Manage' },
  { to: '/admin/blocks', icon: 'ban', label: 'Blocks' },
  { to: '/admin/facilities', icon: 'layers', label: 'Facilities' },
  { to: '/admin/pricing', icon: 'rupee', label: 'Pricing' },
  { to: '/admin/customers', icon: 'users', label: 'Customers' },
  { group: 'Money' },
  { to: '/admin/payments', icon: 'card', label: 'Payments' },
  { to: '/admin/reports', icon: 'chart', label: 'Reports' },
  { group: 'System' },
  { to: '/admin/settings', icon: 'settings', label: 'Settings' },
  { to: '/admin/audit', icon: 'file', label: 'Audit log' },
];

function Nav({ onNavigate }) {
  const { path } = useLocation();
  const { signOut, displayName } = useSession();
  const isActive = (n) => (n.exact ? path === n.to : path === n.to || (path.startsWith(n.to + '/') && !NAV.some((m) => m.to && m.to !== n.to && m.to.startsWith(n.to) && path.startsWith(m.to))));
  return (
    <nav className="admin-nav" aria-label="Admin" onClick={(e) => { if (e.target.closest('a')) onNavigate?.(); }}>
      <Logo light />
      {NAV.map((n, i) => (n.group
        ? <div key={i} className="admin-nav-label">{n.group}</div>
        : <Link key={n.to} to={n.to} className={isActive(n) ? 'active' : ''}><Icon name={n.icon} size={19} />{n.label}</Link>))}
      <div className="admin-nav-foot">
        <Link to="/"><Icon name="home" size={19} />View website</Link>
        <a href="#signout" onClick={(e) => { e.preventDefault(); signOut(); }}><Icon name="logout" size={19} />Sign out{displayName ? ` (${displayName})` : ''}</a>
      </div>
    </nav>
  );
}

export default function AdminApp() {
  const { isLoaded, isSignedIn, signIn, me, meLoading, isAdmin } = useSession();
  const [drawer, setDrawer] = useState(false);
  const { path } = useLocation();

  if (!isLoaded || (isSignedIn && !me && meLoading)) return <div className="page-loader"><Spinner size={28} /></div>;
  if (!isSignedIn) {
    return (
      <main className="container page narrow">
        <Empty icon="shield" title="Admin sign in" action={<Button onClick={signIn}>Sign in</Button>}>Sign in with an admin account to manage the club.</Empty>
      </main>
    );
  }
  if (!isAdmin) {
    return (
      <main className="container page narrow">
        <Empty icon="lock" title="Admins only" action={<Link to="/" className="btn btn-primary">Back to website</Link>}>
          Your account doesn’t have admin access. Ask the owner to grant it in Admin → Customers.
        </Empty>
      </main>
    );
  }
  const current = NAV.filter((n) => n.to).sort((a, b) => b.to.length - a.to.length).find((n) => path === n.to || path.startsWith(n.to + '/'));

  return (
    <div className="admin">
      <aside className="admin-side"><Nav /></aside>
      <div className="admin-content">
        <header className="admin-topbar">
          <button className="icon-btn" onClick={() => setDrawer(true)} aria-label="Open menu"><Icon name="menu" /></button>
          <strong className="grow">{current?.label || 'Admin'}</strong>
          <Link to="/admin/bookings/new" className="icon-btn" aria-label="New booking"><Icon name="plus" /></Link>
        </header>
        {drawer && <div className="admin-drawer" onClick={(e) => { if (e.target === e.currentTarget) setDrawer(false); }}><Nav onNavigate={() => setDrawer(false)} /></div>}
        <main className="admin-main">
          <Routes
            routes={[
              ['/admin', () => <Dashboard />],
              ['/admin/timetable', () => <Timetable />],
              ['/admin/bookings', () => <BookingsList />],
              ['/admin/bookings/new', () => <NewBooking />],
              ['/admin/blocks', () => <Blocks />],
              ['/admin/facilities', () => <Facilities />],
              ['/admin/pricing', () => <Pricing />],
              ['/admin/customers', () => <Customers />],
              ['/admin/payments', () => <Payments />],
              ['/admin/reports', () => <Reports />],
              ['/admin/settings', () => <Settings />],
              ['/admin/audit', () => <Audit />],
            ]}
            fallback={<Empty title="Not found" />}
          />
        </main>
      </div>
    </div>
  );
}
