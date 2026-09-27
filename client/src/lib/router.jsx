// Tiny history-based router (no dependency). Supports :params and query strings.
import { createContext, useContext, useEffect, useState, useCallback } from 'react';

const RouterCtx = createContext(null);

export function navigate(to, { replace = false } = {}) {
  if (replace) window.history.replaceState({}, '', to);
  else window.history.pushState({}, '', to);
  window.dispatchEvent(new Event('app:navigate'));
  if (!to.includes('#')) window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

export function RouterProvider({ children }) {
  const [loc, setLoc] = useState(() => ({ path: window.location.pathname, search: window.location.search }));
  useEffect(() => {
    const update = () => setLoc({ path: window.location.pathname, search: window.location.search });
    window.addEventListener('popstate', update);
    window.addEventListener('app:navigate', update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener('app:navigate', update);
    };
  }, []);
  return <RouterCtx.Provider value={loc}>{children}</RouterCtx.Provider>;
}

export function useLocation() {
  return useContext(RouterCtx);
}

export function useQuery() {
  const { search } = useLocation();
  return new URLSearchParams(search);
}

export function matchPath(pattern, path) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/\/$/, '').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  const m = path.match(re);
  if (!m) return null;
  return Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
}

/** Render the first route whose pattern matches. routes: [[pattern, (params) => element], ...] */
export function Routes({ routes, fallback = null }) {
  const { path } = useLocation();
  for (const [pattern, render] of routes) {
    const params = matchPath(pattern, path);
    if (params) return render(params);
  }
  return fallback;
}

export function Link({ to, children, className, onClick, ...rest }) {
  const handle = useCallback((e) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || rest.target) return;
    e.preventDefault();
    navigate(to);
  }, [to, onClick, rest.target]);
  return <a href={to} className={className} onClick={handle} {...rest}>{children}</a>;
}
