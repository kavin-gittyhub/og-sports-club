import express from 'express';
import { handleWebhook } from '../services/payments.js';
import { rateLimit } from '../lib/http.js';

export const webhookRouter = express.Router();

// Razorpay signs the exact raw bytes, so this route must see the unparsed body.
webhookRouter.post(
  '/razorpay',
  rateLimit({ windowMs: 60_000, max: 300 }),
  express.raw({ type: '*/*', limit: '1mb' }),
  async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    try {
      const result = await handleWebhook({
        rawBody: raw,
        signature: req.get('x-razorpay-signature'),
        eventId: req.get('x-razorpay-event-id'),
      });
      res.json(result);
    } catch (err) {
      console.error('[webhook] razorpay', err.message);
      res.status(err.status && err.status < 500 ? err.status : 500).json({ error: { message: err.message } });
    }
  }
);
