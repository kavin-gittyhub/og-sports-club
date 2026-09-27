// Opens Razorpay Checkout (UPI first) and resolves with the verified booking from our server.
import { api } from './api.js';

let scriptPromise = null;
function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.async = true;
      s.onload = resolve;
      s.onerror = () => { scriptPromise = null; reject(new Error('Could not load the payment window. Check your connection and try again.')); };
      document.body.appendChild(s);
    });
  }
  return scriptPromise;
}

export class PaymentDismissed extends Error {
  constructor() { super('Payment was not completed.'); this.code = 'DISMISSED'; }
}

/**
 * @param checkout server-issued checkout payload
 * @param {{ mockPay?: (checkout) => Promise<boolean> }} opts mockPay shows the dev test-payment dialog
 */
export async function pay(checkout, { mockPay } = {}) {
  if (checkout.provider === 'mock') {
    const confirmed = await mockPay(checkout);
    if (!confirmed) throw new PaymentDismissed();
    return api('/payments/verify', { method: 'POST', body: { orderId: checkout.orderId, mock: true } });
  }

  await loadRazorpay();
  const response = await new Promise((resolve, reject) => {
    const rzp = new window.Razorpay({
      key: checkout.keyId,
      order_id: checkout.orderId,
      amount: checkout.amount,
      currency: checkout.currency,
      name: checkout.name,
      description: checkout.description,
      prefill: checkout.prefill,
      theme: { color: '#0b2b20' },
      // Show UPI first; cards / netbanking / wallets remain available.
      config: {
        display: {
          blocks: { upi: { name: 'Pay using UPI', instruments: [{ method: 'upi' }] } },
          sequence: ['block.upi'],
          preferences: { show_default_blocks: true },
        },
      },
      retry: { enabled: true, max_count: 3 },
      handler: (res) => resolve(res),
      modal: { ondismiss: () => reject(new PaymentDismissed()), confirm_close: true },
    });
    rzp.on('payment.failed', (res) => {
      api('/payments/failed', { method: 'POST', body: { orderId: checkout.orderId, reason: res?.error?.description } }).catch(() => {});
    });
    rzp.open();
  });

  return api('/payments/verify', {
    method: 'POST',
    body: {
      orderId: response.razorpay_order_id,
      paymentId: response.razorpay_payment_id,
      signature: response.razorpay_signature,
    },
  });
}
