import express from 'express';
import { config } from '../config.js';
import { query } from '../db.js';
import { v } from '../lib/validate.js';
import { todayInZone } from '../lib/time.js';
import { listFacilities, getFacilityBySlug, getPricingRules, publicFacility } from '../services/facilities.js';
import { fromPrice } from '../services/pricing.js';
import { getDayAvailability } from '../services/availability.js';
import { quote } from '../services/bookings.js';
import { getSettings } from '../services/settings.js';
import { rateLimit } from '../lib/http.js';

export const publicRouter = express.Router();

publicRouter.get('/config', async (req, res) => {
  const s = await getSettings();
  res.json({
    club: s.club,
    policy: {
      holdMinutes: s.booking_policy.hold_minutes,
      cancellationCutoffHours: s.booking_policy.cancellation_cutoff_hours,
      refundPercent: s.booking_policy.refund_percent,
      extensionOptions: s.booking_policy.extension_options,
    },
    timezone: config.timezone,
    today: todayInZone(config.timezone),
    paymentProvider: config.paymentProvider === 'venue' ? 'venue' : config.paymentProvider === 'mock' && !config.isProduction ? 'mock' : 'razorpay',
    auth: config.clerkSecretKey ? 'clerk' : config.devAuth && !config.isProduction ? 'dev' : 'none',
  });
});

publicRouter.get('/facilities', async (req, res) => {
  const facilities = await listFacilities();
  const out = [];
  for (const fg of facilities) {
    const rules = await getPricingRules(fg.id);
    out.push(publicFacility(fg, { fromPrice: fromPrice(rules) }));
  }
  res.set('Cache-Control', 'public, max-age=30');
  res.json({ facilities: out });
});

publicRouter.get('/facilities/:slug', async (req, res) => {
  const fg = await getFacilityBySlug(v.str(req.params.slug, 'slug', { max: 60 }));
  const rules = await getPricingRules(fg.id);
  res.json({
    facility: publicFacility(fg, { fromPrice: fromPrice(rules) }),
    pricing: rules.map((r) => ({
      label: r.label, days: r.days_of_week, startMinute: r.start_minute, endMinute: r.end_minute, pricePerHour: r.price_per_hour,
    })),
  });
});

const availabilityLimiter = rateLimit({ windowMs: 60_000, max: 120 });

publicRouter.get('/facilities/:slug/availability', availabilityLimiter, async (req, res) => {
  const fg = await getFacilityBySlug(v.str(req.params.slug, 'slug', { max: 60 }));
  const date = v.date(req.query.date, 'date');
  const data = await getDayAvailability({ query }, fg, date);
  res.set('Cache-Control', 'no-store');
  res.json(data);
});

publicRouter.post('/quote', availabilityLimiter, async (req, res) => {
  const b = req.body || {};
  const fg = await getFacilityBySlug(v.str(b.facility, 'facility', { max: 60 }));
  const result = await quote({
    fg,
    date: v.date(b.date, 'date'),
    startMinute: v.int(b.startMinute, 'startMinute', { min: 0, max: 1439 }),
    durationMin: v.int(b.durationMin, 'durationMin', { min: 5, max: 1440 }),
    bowlingMachine: v.bool(b.bowlingMachine, 'bowlingMachine'),
    quantity: v.int(b.quantity ?? 1, 'quantity', { min: 1, max: 50 }),
  });
  res.json(result);
});
