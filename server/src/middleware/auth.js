// Authentication (Clerk) + authorization (customer/admin), enforced on the server.
import { config } from '../config.js';
import { query } from '../db.js';
import { forbidden, unauthorized } from '../lib/errors.js';

let clerk = null; // @clerk/express module, loaded only when configured

export async function initAuth(app) {
  if (config.clerkSecretKey) {
    clerk = await import('@clerk/express');
    app.use(clerk.clerkMiddleware({
      secretKey: config.clerkSecretKey,
      publishableKey: config.clerkPublishableKey || undefined,
      // Only accept session tokens minted for our own site(s).
      authorizedParties: [config.publicUrl, ...config.corsOrigins].filter(Boolean).length
        ? [config.publicUrl, ...config.corsOrigins].filter(Boolean)
        : undefined,
    }));
    console.log('[auth] Clerk enabled');
  } else if (config.devAuth && !config.isProduction) {
    console.warn('[auth] ⚠ DEV_AUTH enabled — X-Dev-User header login. Never use in production.');
  }
}

async function fetchClerkProfile(clerkUserId) {
  try {
    const u = await clerk.clerkClient.users.getUser(clerkUserId);
    const primaryEmail = u.emailAddresses?.find((e) => e.id === u.primaryEmailAddressId)?.emailAddress
      || u.emailAddresses?.[0]?.emailAddress || null;
    const phone = u.phoneNumbers?.find((p) => p.id === u.primaryPhoneNumberId)?.phoneNumber || null;
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || null;
    return { email: primaryEmail, phone, name };
  } catch (err) {
    console.error('[auth] could not load Clerk profile', err.message);
    return { email: null, phone: null, name: null };
  }
}

async function identify(req) {
  if (clerk) {
    const auth = clerk.getAuth(req);
    if (auth?.userId) return { externalId: auth.userId, source: 'clerk' };
  }
  if (config.devAuth && !config.isProduction) {
    const email = String(req.get('x-dev-user') || '').trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { externalId: `dev_${email}`, source: 'dev', email };
  }
  return null;
}

async function loadOrCreateUser(identity) {
  const { rows } = await query('SELECT * FROM users WHERE clerk_user_id = $1', [identity.externalId]);
  let user = rows[0];
  if (!user) {
    const profile = identity.source === 'clerk'
      ? await fetchClerkProfile(identity.externalId)
      : { email: identity.email, name: identity.email.split('@')[0].replace(/[._]/g, ' '), phone: null };
    // Link to a walk-in profile the admin created earlier with the same email, if any.
    const existing = profile.email
      ? (await query('SELECT * FROM users WHERE lower(email) = lower($1) AND clerk_user_id IS NULL LIMIT 1', [profile.email])).rows[0]
      : null;
    if (existing) {
      user = (await query(
        `UPDATE users SET clerk_user_id = $1, is_walk_in = false, name = COALESCE(name, $2), phone = COALESCE(phone, $3), updated_at = now()
         WHERE id = $4 RETURNING *`,
        [identity.externalId, profile.name, profile.phone, existing.id]
      )).rows[0];
    } else {
      user = (await query(
        `INSERT INTO users (clerk_user_id, email, name, phone) VALUES ($1,$2,$3,$4)
         ON CONFLICT (clerk_user_id) DO UPDATE SET updated_at = now() RETURNING *`,
        [identity.externalId, profile.email, profile.name, profile.phone]
      )).rows[0];
    }
  }
  // Bootstrap admins from ADMIN_EMAILS (promotion only; demotion is done in the admin UI).
  if (user.role !== 'admin' && user.email && config.adminEmails.includes(user.email.toLowerCase())) {
    user = (await query(`UPDATE users SET role = 'admin', updated_at = now() WHERE id = $1 RETURNING *`, [user.id])).rows[0];
  }
  return user;
}

/** Attaches req.user when a valid session exists; never rejects. */
export async function optionalAuth(req, res, next) {
  const identity = await identify(req);
  if (identity) req.user = await loadOrCreateUser(identity);
  next();
}

export async function requireAuth(req, res, next) {
  const identity = await identify(req);
  if (!identity) throw unauthorized();
  req.user = await loadOrCreateUser(identity);
  if (req.user.is_blocked) throw forbidden('Your account has been suspended. Please contact the club.');
  next();
}

export async function requireAdmin(req, res, next) {
  await requireAuth(req, res, () => {});
  if (req.user.role !== 'admin') throw forbidden('Admin access only.');
  next();
}
