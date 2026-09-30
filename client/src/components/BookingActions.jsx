// Customer actions on a booking: extend, cancel, complete payment, add to calendar.
import { useState, useRef, useEffect } from 'react';
import { api } from '../lib/api.js';
import { pay, PaymentDismissed } from '../lib/payments.js';
import { money, fmtMin, fmtDuration } from '../lib/format.js';
import { Button, Modal, Spinner, useToast, useConfirm } from './ui.jsx';
import { Icon } from './Icons.jsx';

function useMockPay() {
  const [checkout, setCheckout] = useState(null);
  const resolver = useRef(null);
  const mockPay = (c) => new Promise((resolve) => { resolver.current = resolve; setCheckout(c); });
  const dialog = (
    <Modal
      open={Boolean(checkout)} onClose={() => { setCheckout(null); resolver.current?.(false); }} title="Test payment" size="sm"
      footer={<><Button variant="ghost" onClick={() => { setCheckout(null); resolver.current?.(false); }}>Cancel</Button><Button icon="check" onClick={() => { setCheckout(null); resolver.current?.(true); }}>Pay {money(checkout?.amount)}</Button></>}
    >
      <div className="alert alert-info"><Icon name="info" /><div>Development mode — no real money is charged.</div></div>
      <p className="mt"><strong>{checkout?.description}</strong></p>
    </Modal>
  );
  return { mockPay, dialog };
}

export function icsFor(b, clubName = 'OG Sports Club', address = '') {
  const dt = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//OG Sports Club//Booking//EN', 'BEGIN:VEVENT',
    `UID:${b.id}@ogsports`, `DTSTAMP:${dt(new Date().toISOString())}`, `DTSTART:${dt(b.startAt)}`, `DTEND:${dt(b.endAt)}`,
    `SUMMARY:${b.facility.name} – ${clubName}`, `DESCRIPTION:Booking ${b.ref}${b.bowlingMachine ? ' · Bowling machine' : ''}`,
    address ? `LOCATION:${address.replace(/,/g, '\\,')}` : '', 'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean);
  return lines.join('\r\n');
}

export function addToCalendar(b, club) {
  const blob = new Blob([icsFor(b, club?.name, club?.address)], { type: 'text/calendar' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${b.ref}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function ExtendDialog({ booking, open, onClose, onDone }) {
  const toast = useToast();
  const [options, setOptions] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const { mockPay, dialog } = useMockPay();
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setOptions(null); setError(null);
    api(`/bookings/${booking.id}/extensions`).then((d) => alive && setOptions(d.options)).catch((e) => alive && setError(e));
    return () => { alive = false; };
  }, [open, booking.id, booking.endMinute]);

  const choose = async (opt) => {
    setBusy(opt.minutes);
    try {
      const res = await api(`/bookings/${booking.id}/extensions`, { method: 'POST', body: { minutes: opt.minutes } });
      const result = res.checkout ? await pay(res.checkout, { mockPay }) : res;
      if (result.outcome === 'extended') toast.success(`Extended — you now play until ${fmtMin(result.booking.endMinute)}.`);
      else toast.error('Sorry, that time was taken while you were paying. You have been refunded.');
      onDone?.(result.booking);
      onClose();
    } catch (err) {
      if (!(err instanceof PaymentDismissed)) toast.error(err.message);
      if (err.status === 409) api(`/bookings/${booking.id}/extensions`).then((d) => setOptions(d.options)).catch(() => {});
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Modal open={open} onClose={onClose} title="Extend your booking" size="sm">
        <p className="muted">Currently until <strong>{fmtMin(booking.endMinute)}</strong>. Add more time if the next slot is free{booking.quantity > 1 ? ` on all ${booking.quantity} of your ${booking.facility.unitLabel}s` : ''}.</p>
        {error && <div className="alert alert-error mt"><Icon name="alert" /><div>{error.message}</div></div>}
        {!options && !error && <div className="center-x mt-lg"><Spinner /></div>}
        <div className="stack mt">
          {options?.map((o) => (
            <button key={o.minutes} className="option-row" disabled={!o.available || busy !== null} onClick={() => choose(o)}>
              <span className="option-row-main">
                <strong>+{fmtDuration(o.minutes)}</strong>
                <span className="muted small">{o.available ? `until ${fmtMin(o.newEndMinute)}` : o.reason}</span>
              </span>
              {o.available ? (busy === o.minutes ? <Spinner size={16} /> : <strong>{money(o.amount)}</strong>) : <Icon name="lock" size={18} />}
            </button>
          ))}
        </div>
      </Modal>
      {dialog}
    </>
  );
}

export function BookingActions({ booking, onChange, club, compact = false }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [extendOpen, setExtendOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { mockPay, dialog } = useMockPay();
  const b = booking;

  const cancel = async () => {
    const refundText = b.status === 'pending_payment'
      ? 'Your held slot will be released.'
      : b.cancellation.refund > 0 ? `You’ll receive a refund of ${money(b.cancellation.refund)} to your original payment method (usually 5–7 working days).` : 'No refund applies to this booking.';
    const ok = await confirm({
      title: 'Cancel this booking?',
      message: <><p><strong>{b.facility.name}</strong> · {fmtMin(b.startMinute)} – {fmtMin(b.endMinute)}</p><p className="muted mt-sm">{refundText}</p></>,
      confirmText: 'Yes, cancel booking',
      cancelText: 'Keep booking',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await api(`/bookings/${b.id}/cancel`, { method: 'POST', body: {} });
      toast.success(res.refund.amount > 0 ? `Booking cancelled. Refund of ${money(res.refund.amount)} initiated.` : 'Booking cancelled.');
      onChange?.(res.booking);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const completePayment = async () => {
    setBusy(true);
    try {
      const { checkout } = await api(`/bookings/${b.id}/pay`, { method: 'POST' });
      const result = await pay(checkout, { mockPay });
      toast.success('Payment received — booking confirmed!');
      onChange?.(result.booking);
    } catch (err) {
      if (!(err instanceof PaymentDismissed)) toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const upcoming = ['upcoming', 'in_progress'].includes(b.displayStatus);
  return (
    <div className={`booking-actions ${compact ? 'is-compact' : ''}`}>
      {b.displayStatus === 'pending_payment' && (
        <Button size={compact ? 'sm' : undefined} onClick={completePayment} loading={busy} icon="card">Complete payment</Button>
      )}
      {b.canExtend && (
        <Button size={compact ? 'sm' : undefined} variant="outline" icon="plus" onClick={() => setExtendOpen(true)}>Extend</Button>
      )}
      {upcoming && !compact && (
        <Button variant="ghost" icon="calendar" onClick={() => addToCalendar(b, club)}>Add to calendar</Button>
      )}
      {b.cancellation.allowed && (
        <Button size={compact ? 'sm' : undefined} variant="ghost-danger" onClick={cancel} loading={busy && b.displayStatus !== 'pending_payment'}>
          Cancel
        </Button>
      )}
      {upcoming && !b.cancellation.allowed && !compact && b.cancellation.reason && (
        <p className="muted small full">{b.cancellation.reason}</p>
      )}
      {b.canExtend && <ExtendDialog booking={b} open={extendOpen} onClose={() => setExtendOpen(false)} onDone={onChange} />}
      {dialog}
    </div>
  );
}
