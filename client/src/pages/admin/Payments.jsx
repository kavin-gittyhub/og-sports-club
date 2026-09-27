import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/auth.jsx';
import { money, fmtDateTime, addDays, rupeesToPaise, paiseToRupees } from '../../lib/format.js';
import { Button, ErrorBox, Field, Modal, PaymentBadge, Empty, Skeleton, useAsync, useToast } from '../../components/ui.jsx';
import { PageHead, RupeeInput } from './shared.jsx';
import { BookingDrawer } from './BookingDrawer.jsx';

function RefundModal({ payment, onClose, onDone }) {
  const toast = useToast();
  const max = payment.amount - payment.refundAmount;
  const [amount, setAmount] = useState(paiseToRupees(max));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api(`/admin/payments/${payment.id}/refund`, { method: 'POST', body: { amount: rupeesToPaise(amount), reason } });
      toast.success(`Refunded ${money(r.refunded)}`);
      onDone(); onClose();
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Refund payment" size="sm" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" onClick={submit} loading={busy}>Refund</Button></>}>
      <p className="muted">{payment.customerName} · {payment.bookingRef} · paid {money(payment.amount)}{payment.provider === 'razorpay' ? ' online — money goes back to the original method.' : ' at the desk — hand the cash back to the customer.'}</p>
      <Field label={`Amount (max ${money(max)})`}><RupeeInput value={amount} onChange={setAmount} /></Field>
      <Field label="Reason" className="mt"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <p className="muted small mt">Refunding does not cancel the booking. To free the slot, cancel the booking instead.</p>
    </Modal>
  );
}

export default function Payments() {
  const { config } = useSession();
  const today = config?.today;
  const [f, setF] = useState({ from: today ? addDays(today, -29) : '', to: today || '', status: '' });
  const [refund, setRefund] = useState(null);
  const [openBooking, setOpenBooking] = useState(null);
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const { data, loading, error, reload } = useAsync(() => api(`/admin/payments?${qs}`), [qs]);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const collected = (data?.payments || []).filter((p) => ['paid', 'partially_refunded', 'refunded', 'refund_pending'].includes(p.status)).reduce((s, p) => s + p.amount - p.refundAmount, 0);

  return (
    <>
      <PageHead title="Payments" sub={data ? `${money(collected)} net collected in this range` : ' '} />
      <div className="toolbar">
        <Field label="From"><input className="input" type="date" value={f.from} onChange={set('from')} /></Field>
        <Field label="To"><input className="input" type="date" value={f.to} onChange={set('to')} /></Field>
        <Field label="Status">
          <select className="select" value={f.status} onChange={set('status')}>
            <option value="">All</option>
            <option value="paid">Paid</option>
            <option value="refund_pending">Refund pending</option>
            <option value="refunded">Refunded</option>
            <option value="partially_refunded">Partly refunded</option>
            <option value="failed">Failed</option>
            <option value="created">Started (not completed)</option>
          </select>
        </Field>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Date</th><th>Booking</th><th>Customer</th><th>Method</th><th>Status</th><th className="num">Amount</th><th /></tr></thead>
          <tbody>
            {loading && !data && Array.from({ length: 6 }, (_, i) => <tr key={i}><td colSpan={7}><Skeleton h={18} /></td></tr>)}
            {data?.payments.map((p) => (
              <tr key={p.id}>
                <td>{fmtDateTime(p.paidAt || p.createdAt)}</td>
                <td><button className="link-btn" onClick={() => setOpenBooking(p.bookingId)}>{p.bookingRef}</button><div className="cell-sub">{p.facilityName}{p.extensionId ? ' · extension' : ''}</div></td>
                <td>{p.customerName}</td>
                <td>{p.provider === 'razorpay' ? `Online · ${p.method || '—'}` : p.provider === 'mock' ? 'Test' : p.provider.replace('_offline', ' (desk)')}<div className="cell-sub mono">{p.paymentId || p.orderId || ''}</div></td>
                <td><PaymentBadge status={p.status} />{p.failureReason && <div className="cell-sub">{p.failureReason}</div>}</td>
                <td className="num"><div className="cell-strong">{money(p.amount)}</div>{p.refundAmount > 0 && <div className="cell-sub">−{money(p.refundAmount)}</div>}</td>
                <td className="num">{['paid', 'partially_refunded', 'refund_pending'].includes(p.status) && p.amount > p.refundAmount && <Button variant="ghost" size="sm" onClick={() => setRefund(p)}>Refund</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.payments.length === 0 && <Empty icon="card" title="No payments in this range" />}
      </div>
      {refund && <RefundModal payment={refund} onClose={() => setRefund(null)} onDone={() => reload({ silent: true })} />}
      <BookingDrawer id={openBooking} onClose={() => setOpenBooking(null)} onChanged={() => reload({ silent: true })} />
    </>
  );
}
