// Shared UI primitives: buttons, modals, confirm dialogs, toasts, badges, loaders.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Icon } from './Icons.jsx';
import { STATUS_LABEL, PAYMENT_LABEL } from '../lib/format.js';

export function Spinner({ size = 18, className = '' }) {
  return <span className={`spinner ${className}`} style={{ width: size, height: size }} role="status" aria-label="Loading" />;
}

export function Button({ variant = 'primary', size, loading = false, icon, iconRight, children, className = '', disabled, ...rest }) {
  return (
    <button
      className={`btn btn-${variant} ${size ? `btn-${size}` : ''} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={16} /> : icon ? <Icon name={icon} size={18} /> : null}
      {children && <span>{children}</span>}
      {iconRight && !loading && <Icon name={iconRight} size={18} />}
    </button>
  );
}

export function Modal({ open, onClose, title, children, footer, size = 'md', labelledBy }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    const prev = document.activeElement;
    setTimeout(() => ref.current?.querySelector('input,select,textarea,button:not(.modal-close)')?.focus(), 30);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('no-scroll');
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div ref={ref} className={`modal modal-${size}`} role="dialog" aria-modal="true" aria-label={title} aria-labelledby={labelledBy} onMouseDown={(e) => e.stopPropagation()}>
        {title && (
          <div className="modal-head">
            <h2>{title}</h2>
            <button className="icon-btn modal-close" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ───────────── Confirm dialogs (promise-based)
const ConfirmCtx = createContext(null);
export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null);
  const confirm = useCallback((opts) => new Promise((resolve) => setState({ ...opts, resolve })), []);
  const close = (v) => { state?.resolve(v); setState(null); };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Modal
        open={Boolean(state)}
        onClose={() => close(false)}
        title={state?.title}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => close(false)}>{state?.cancelText || 'Go back'}</Button>
            <Button variant={state?.danger ? 'danger' : 'primary'} onClick={() => close(true)}>{state?.confirmText || 'Confirm'}</Button>
          </>
        }
      >
        {typeof state?.message === 'string' ? <p className="muted">{state.message}</p> : state?.message}
      </Modal>
    </ConfirmCtx.Provider>
  );
}
export const useConfirm = () => useContext(ConfirmCtx);

// ───────────── Toasts
const ToastCtx = createContext(null);
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((type, message, ms = 4500) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-2), { id, type, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ms);
  }, []);
  const api = useRef(null);
  if (!api.current) api.current = {};
  api.current.success = (m) => push('success', m);
  api.current.error = (m) => push('error', m, 6500);
  api.current.info = (m) => push('info', m);
  return (
    <ToastCtx.Provider value={api.current}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.type}`} role={t.type === 'error' ? 'alert' : 'status'}>
            <Icon name={t.type === 'success' ? 'checkCircle' : t.type === 'error' ? 'alert' : 'info'} size={20} />
            <span>{t.message}</span>
            <button className="icon-btn" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}><Icon name="x" size={16} /></button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ───────────── Small pieces
const STATUS_TONE = {
  upcoming: 'green', confirmed: 'green', in_progress: 'blue', completed: 'gray', cancelled: 'red', expired: 'gray', pending_payment: 'amber',
};
export function StatusBadge({ status }) {
  return <span className={`badge badge-${STATUS_TONE[status] || 'gray'}`}>{STATUS_LABEL[status] || status}</span>;
}
const PAY_TONE = { paid: 'green', pay_at_venue: 'amber', unpaid: 'amber', refund_pending: 'amber', refunded: 'gray', partially_refunded: 'gray', failed: 'red', created: 'gray' };
export function PaymentBadge({ status }) {
  return <span className={`badge badge-${PAY_TONE[status] || 'gray'} badge-soft`}>{PAYMENT_LABEL[status] || status}</span>;
}
export function Badge({ tone = 'gray', children }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Empty({ icon = 'calendar', title, children, action }) {
  return (
    <div className="empty">
      <div className="empty-icon"><Icon name={icon} size={28} /></div>
      <h3>{title}</h3>
      {children && <p className="muted">{children}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ h = 16, w = '100%', r = 8, className = '' }) {
  return <span className={`skeleton ${className}`} style={{ height: h, width: w, borderRadius: r }} />;
}

export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="alert alert-error" role="alert">
      <Icon name="alert" />
      <div className="grow">{error.message || String(error)}</div>
      {onRetry && <Button variant="ghost" size="sm" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

export function Field({ label, hint, error, children, className = '' }) {
  return (
    <label className={`field ${className}`}>
      {label && <span className="field-label">{label}</span>}
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, disabled }) {
  return (
    <label className={`toggle ${disabled ? 'is-disabled' : ''}`}>
      <input type="checkbox" checked={Boolean(checked)} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      <span className="toggle-track"><span className="toggle-thumb" /></span>
      {label && <span>{label}</span>}
    </label>
  );
}

/** Fetch helper hook with loading/error/reload. */
export function useAsync(fn, deps = []) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const counter = useRef(0);
  const run = useCallback(async ({ silent = false } = {}) => {
    const n = ++counter.current;
    if (!silent) setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fn();
      if (n === counter.current) setState({ loading: false, error: null, data });
      return data;
    } catch (error) {
      if (n === counter.current) setState((s) => ({ loading: false, error, data: silent ? s.data : null }));
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { ...state, reload: run, setData: (d) => setState((s) => ({ ...s, data: typeof d === 'function' ? d(s.data) : d })) };
}
