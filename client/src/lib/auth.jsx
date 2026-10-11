// Authentication: Clerk in production; an explicit dev-only fallback for local testing.
import { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import { ClerkProvider, useAuth as useClerkAuth, useUser, useClerk } from '@clerk/clerk-react';
import { api, setAuthHeaderProvider } from './api.js';

const PK = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const DEV_AUTH = !PK && (import.meta.env.DEV || import.meta.env.VITE_DEV_AUTH === 'true');

const AuthCtx = createContext(null);

export function useSession() {
  return useContext(AuthCtx);
}

function SessionState({ base, children }) {
  const [me, setMe] = useState(null);
  const [meLoading, setMeLoading] = useState(false);
  const [config, setConfig] = useState(null);

  useEffect(() => {
    api('/config').then(setConfig).catch(() => setConfig({ club: { name: 'OG Sports Club' }, policy: {}, today: new Date().toISOString().slice(0, 10) }));
  }, []);

  const refreshMe = useCallback(async () => {
    if (!base.isSignedIn) { setMe(null); return null; }
    setMeLoading(true);
    try {
      const { user } = await api('/me');
      setMe(user);
      return user;
    } catch {
      setMe(null);
      return null;
    } finally {
      setMeLoading(false);
    }
  }, [base.isSignedIn]);

  useEffect(() => { if (base.isLoaded) refreshMe(); }, [base.isLoaded, base.isSignedIn, refreshMe]);

  const value = useMemo(() => ({
    ...base, me, meLoading, refreshMe, config, isAdmin: me?.role === 'admin' || Boolean(config?.demoOpenAdmin),
  }), [base, me, meLoading, refreshMe, config]);
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

// ───────────────────────────────── Clerk
function ClerkBridge({ children }) {
  const { isLoaded, isSignedIn, getToken, signOut } = useClerkAuth();
  const { user } = useUser();
  const clerk = useClerk();
  // Set synchronously (not in an effect) so child components' first requests are authenticated.
  setAuthHeaderProvider(async () => {
    const token = await getToken().catch(() => null);
    return token ? { Authorization: `Bearer ${token}` } : {};
  });
  const base = useMemo(() => ({
    mode: 'clerk',
    isLoaded,
    isSignedIn: Boolean(isSignedIn),
    displayName: user?.firstName || user?.fullName || user?.primaryEmailAddress?.emailAddress || '',
    imageUrl: user?.imageUrl,
    signIn: () => clerk.openSignIn({}),
    signUp: () => clerk.openSignUp({}),
    signOut: () => signOut({ redirectUrl: '/' }),
    openProfile: () => clerk.openUserProfile(),
  }), [isLoaded, isSignedIn, user, clerk, signOut]);
  return <SessionState base={base}>{children}</SessionState>;
}

// ───────────────────────────────── Dev (local only)
const DEV_KEY = 'og_dev_user';
function readDevUser() {
  try { return localStorage.getItem(DEV_KEY) || ''; } catch { return ''; }
}

function DevAuth({ children }) {
  const [email, setEmail] = useState(readDevUser);
  const [prompting, setPrompting] = useState(false);
  setAuthHeaderProvider(async () => (email ? { 'X-Dev-User': email } : {}));
  const base = useMemo(() => ({
    mode: 'dev',
    isLoaded: true,
    isSignedIn: Boolean(email),
    displayName: email ? email.split('@')[0] : '',
    imageUrl: null,
    signIn: () => setPrompting(true),
    signUp: () => setPrompting(true),
    signOut: () => { try { localStorage.removeItem(DEV_KEY); } catch { /* */ } setEmail(''); },
    openProfile: () => {},
  }), [email]);
  const choose = (e) => {
    try { localStorage.setItem(DEV_KEY, e); } catch { /* */ }
    setAuthHeaderProvider(async () => ({ 'X-Dev-User': e }));
    setEmail(e);
    setPrompting(false);
  };
  return (
    <SessionState base={base}>
      {children}
      {prompting && <DevSignIn onChoose={choose} onClose={() => setPrompting(false)} />}
    </SessionState>
  );
}

function DevSignIn({ onChoose, onClose }) {
  const [value, setValue] = useState('');
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="dev-signin-title" onMouseDown={(e) => e.stopPropagation()}>
        <h2 id="dev-signin-title">Sign in (development mode)</h2>
        <p className="muted small">Clerk is not configured, so this local-only sign-in is shown. It is disabled in production.</p>
        <form onSubmit={(e) => { e.preventDefault(); if (/\S+@\S+\.\S+/.test(value)) onChoose(value.trim().toLowerCase()); }}>
          <label className="field">
            <span>Email</span>
            <input className="input" type="email" autoFocus required value={value} onChange={(e) => setValue(e.target.value)} placeholder="you@example.com" />
          </label>
          <div className="row gap-sm wrap mt">
            <button className="btn btn-primary" type="submit">Continue</button>
            <button className="btn btn-ghost" type="button" onClick={() => onChoose('player@example.com')}>Demo customer</button>
            <button className="btn btn-ghost" type="button" onClick={() => onChoose('owner@ogsports.test')}>Demo owner (admin)</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function NoAuth({ children }) {
  const base = useMemo(() => ({
    mode: 'none', isLoaded: true, isSignedIn: false, displayName: '', signIn: () => alert('Sign-in is not configured. Set VITE_CLERK_PUBLISHABLE_KEY.'),
    signUp: () => {}, signOut: () => {}, openProfile: () => {},
  }), []);
  return <SessionState base={base}>{children}</SessionState>;
}

export function AuthProvider({ children }) {
  if (PK) {
    return (
      <ClerkProvider publishableKey={PK} afterSignOutUrl="/">
        <ClerkBridge>{children}</ClerkBridge>
      </ClerkProvider>
    );
  }
  if (DEV_AUTH) return <DevAuth>{children}</DevAuth>;
  return <NoAuth>{children}</NoAuth>;
}
