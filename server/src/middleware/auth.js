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

// Role set in Clerk dashboard → Users → (user) → Metadata → Public: { "role": "admin" }
// Cached briefly so we don't call Clerk's API on every request.
const ROLE_TTL_MS = 60 * 1000;
const roleCache = new Map(); // clerkUserId -> { role, at }

async function fetchClerkRole(clerkUserId, sessionClaims) {
  // Fast path: if a Clerk session-token template exposes the metadata, use it.
  const claimRole = sessionClaims?.metadata?.role ?? sessionClaims?.public_metadata?.role;
  if (claimRole) return String(claimRole).toLowerCase();

  const hit = roleCache.get(clerkUserId);
  if (hit && Date.now() - hit.at < ROLE_TTL_MS) return hit.role;
  try {
    const u = await clerk.clerkClient.users.getUser(clerkUserId);
    const role = u.publicMetadata?.role ? String(u.publicMetadata.role).toLowerCase() : null;
    roleCache.set(clerkUserId, { role, at: Date.now() });
    return role;
  } catch (err) {
    console.error('[auth] could not load Clerk role', err.message);
    return hit?.role ?? null; // keep last known value on a temporary failure
  }
}

async function identify(req) {
  if (clerk) {
    const auth = clerk.getAuth(req);
    if (auth?.userId) return { externalId: auth.userId, source: 'clerk', sessionClaims: auth.sessionClaims };
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
  // 1) Clerk dashboard is the main source of admin access:
  //    publicMetadata.role = "admin"    → admin
  //    publicMetadata.role = "customer" → admin access removed
  //    (no role set)                    → keep whatever the database says
  //    (so admins granted from Admin → Customers keep working)
  let wanted = null;
  if (identity.source === 'clerk') {
    const clerkRole = await fetchClerkRole(identity.externalId, identity.sessionClaims);
    if (clerkRole === 'admin' || clerkRole === 'customer') wanted = clerkRole;
  }
  // 2) Optional fallback: ADMIN_EMAILS (promotion only). Can be left empty.
  if (!wanted && user.role !== 'admin' && user.email && config.adminEmails.includes(user.email.toLowerCase())) {
    wanted = 'admin';
  }
  if (wanted && wanted !== user.role) {
    user = (await query(`UPDATE users SET role = $2, updated_at = now() WHERE id = $1 RETURNING *`, [user.id, wanted])).rows[0];
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

// DEMO_OPEN_ADMIN: a shared "Demo Admin" account used when a visitor opens /admin without signing in,
// so bookings, blocks and audit-log entries still have an owner.
let demoAdminCache = null;
async function getDemoAdmin() {
  if (demoAdminCache) return demoAdminCache;
  demoAdminCache = (await query(
    `INSERT INTO users (clerk_user_id, email, name, role) VALUES ('demo_admin', 'demo-admin@demo.local', 'Demo Admin', 'admin')
     ON CONFLICT (clerk_user_id) DO UPDATE SET role = 'admin', is_blocked = false, updated_at = now() RETURNING *`
  )).rows[0];
  return demoAdminCache;
}

export async function requireAdmin(req, res, next) {
  if (config.demoOpenAdmin) {
    const identity = await identify(req);
    // Signed-in visitors act as themselves (role raised for this request only, nothing saved);
    // everyone else acts as the shared Demo Admin.
    req.user = identity ? { ...(await loadOrCreateUser(identity)), role: 'admin' } : await getDemoAdmin();
    return next();
  }
  await requireAuth(req, res, () => {});
  if (req.user.role !== 'admin') throw forbidden('Admin access only.');
  next();
}
