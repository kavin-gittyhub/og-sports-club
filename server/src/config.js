// Centralised, validated configuration. Secrets live only on the server.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Minimal .env loader for local development (Render injects env vars directly).
function loadDotEnv() {
  for (const candidate of [path.resolve(here, '../.env'), path.resolve(here, '../../.env')]) {
    if (!fs.existsSync(candidate)) continue;
    for (const line of fs.readFileSync(candidate, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m || line.trim().startsWith('#')) continue;
      let value = m[2];
      if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
  }
}
loadDotEnv();

const env = process.env;
const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

export const config = {
  nodeEnv: env.NODE_ENV || 'development',
  isProduction: env.NODE_ENV === 'production',
  port: Number(env.PORT || 4000),
  databaseUrl: env.DATABASE_URL || '',
  databaseSsl: bool(env.DATABASE_SSL, env.NODE_ENV === 'production'),
  timezone: env.CLUB_TIMEZONE || 'Asia/Kolkata',
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
  corsOrigins: (env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),

  // Auth
  clerkSecretKey: env.CLERK_SECRET_KEY || '',
  clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY || env.VITE_CLERK_PUBLISHABLE_KEY || '',
  adminEmails: (env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  devAuth: bool(env.DEV_AUTH, false),
  // DEMO ONLY: when true, anyone who opens /admin gets full admin access — no sign-in, no admin email needed.
  demoOpenAdmin: bool(env.DEMO_OPEN_ADMIN, false),

  // Payments
  paymentProvider: (env.PAYMENT_PROVIDER || 'razorpay').toLowerCase(), // razorpay | venue (pay at the club) | mock (dev only)
  razorpayKeyId: env.RAZORPAY_KEY_ID || '',
  razorpayKeySecret: env.RAZORPAY_KEY_SECRET || '',
  razorpayWebhookSecret: env.RAZORPAY_WEBHOOK_SECRET || '',

  // Behaviour
  runMigrationsOnStart: bool(env.RUN_MIGRATIONS_ON_START, true),
  seedDemoData: bool(env.SEED_DEMO_DATA, false),
};

/** Online payment is switched off: bookings are confirmed straight away and paid at the club. */
export const payAtVenue = () => config.paymentProvider === 'venue';

export function assertConfig() {
  const problems = [];
  if (!config.databaseUrl) problems.push('DATABASE_URL is required');
  if (config.isProduction) {
    if (config.devAuth) problems.push('DEV_AUTH must never be enabled in production');
    if (!config.clerkSecretKey) problems.push('CLERK_SECRET_KEY is required in production');
    if (config.paymentProvider === 'mock') problems.push('PAYMENT_PROVIDER=mock is not allowed in production');
    if (config.paymentProvider === 'razorpay') {
      if (!config.razorpayKeyId || !config.razorpayKeySecret) problems.push('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required');
      if (!config.razorpayWebhookSecret) problems.push('RAZORPAY_WEBHOOK_SECRET is required');
    }
  } else if (!config.clerkSecretKey && !config.devAuth) {
    problems.push('Set CLERK_SECRET_KEY, or DEV_AUTH=true for local development');
  }
  if (!['razorpay', 'venue', 'mock'].includes(config.paymentProvider)) problems.push('PAYMENT_PROVIDER must be razorpay, venue or mock');
  if (config.demoOpenAdmin) console.warn('[auth] ⚠ DEMO_OPEN_ADMIN=true — the admin dashboard is open to EVERYONE. Turn this off before real use.');
  if (problems.length) {
    const err = new Error('Invalid configuration:\n  - ' + problems.join('\n  - '));
    err.code = 'CONFIG';
    throw err;
  }
}
