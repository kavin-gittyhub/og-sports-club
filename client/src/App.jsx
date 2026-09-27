import { lazy, Suspense } from 'react';
import { Routes, useLocation, Link } from './lib/router.jsx';
import { SiteHeader, SiteFooter, BottomNav } from './components/Layout.jsx';
import { Spinner, Empty } from './components/ui.jsx';
import Home from './pages/Home.jsx';
import Book from './pages/Book.jsx';
import BookingDetail from './pages/BookingDetail.jsx';
import MyBookings from './pages/MyBookings.jsx';

const AdminApp = lazy(() => import('./pages/admin/AdminApp.jsx'));

function PageLoader() {
  return <div className="page-loader"><Spinner size={28} /></div>;
}

function NotFound() {
  return (
    <main className="container page">
      <Empty icon="search" title="Page not found" action={<Link className="btn btn-primary" to="/">Go home</Link>}>
        The page you’re looking for doesn’t exist.
      </Empty>
    </main>
  );
}

export default function App() {
  const { path } = useLocation();
  if (path.startsWith('/admin')) {
    return (
      <Suspense fallback={<PageLoader />}>
        <AdminApp />
      </Suspense>
    );
  }
  const isBooking = path.startsWith('/book');
  return (
    <div className={`app ${isBooking ? 'is-booking' : ''}`}>
      <a className="skip-link" href="#main">Skip to content</a>
      <SiteHeader />
      <div id="main">
        <Routes
          routes={[
            ['/', () => <Home />],
            ['/book', () => <Book />],
            ['/booking/:id', ({ id }) => <BookingDetail id={id} />],
            ['/my-bookings', () => <MyBookings />],
          ]}
          fallback={<NotFound />}
        />
      </div>
      {!isBooking && <SiteFooter />}
      <BottomNav />
    </div>
  );
}
