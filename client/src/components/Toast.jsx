import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icons';

// Lightweight, app-wide toast notifications.
//
//   const toast = useToast();
//   toast.error('Failed to fetch resources');
//   toast.error('Detail…', { title: 'Namespaces' });
//   toast.success('Context switched');
//
// Errors are sticky (no auto-dismiss) since they usually need attention;
// success/info fade after a few seconds. Duplicate messages are coalesced so a
// failing poll doesn't stack dozens of identical toasts (and the auto-dismiss
// timer is extended each time a duplicate arrives).
//
// Accessibility: success/info toasts live in a polite live region
// (`role="status"`); errors in a separate assertive region (`role="alert"`).

const ToastContext = createContext(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return ctx;
}

const AUTO_DISMISS = { success: 3500, info: 4500, warning: 6000, error: 0 }; // 0 = sticky
const ICON = { success: 'check', info: 'details', warning: 'warning', error: 'warning' };

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const listRef = useRef([]); // synchronous mirror of `toasts` for coalescing
  const idRef = useRef(0);
  const timers = useRef(new Map());

  const commit = useCallback((next) => { listRef.current = next; setToasts(next); }, []);

  const dismiss = useCallback((id) => {
    commit(listRef.current.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) { clearTimeout(timer); timers.current.delete(id); }
  }, [commit]);

  const push = useCallback((type, message, opts = {}) => {
    if (!message) return undefined;
    const kind = AUTO_DISMISS[type] === undefined ? 'info' : type;
    const key = `${kind}:${opts.title || ''}:${message}`;
    const ttl = opts.duration ?? AUTO_DISMISS[kind] ?? 4000;
    const existing = listRef.current.find((t) => t.key === key);
    let id;
    if (existing) {
      id = existing.id;
      commit(listRef.current.map((t) => (t.id === id ? { ...t, count: t.count + 1 } : t)));
      // Extend the lifetime: restart the auto-dismiss timer for the coalesced toast.
      const old = timers.current.get(id);
      if (old) { clearTimeout(old); timers.current.delete(id); }
    } else {
      id = ++idRef.current;
      commit([...listRef.current, { id, key, type: kind, message, title: opts.title, count: 1 }]);
    }
    if (ttl > 0) timers.current.set(id, setTimeout(() => dismiss(id), ttl));
    return id;
  }, [commit, dismiss]);

  useEffect(() => () => { timers.current.forEach((t) => clearTimeout(t)); timers.current.clear(); }, []);

  const api = useMemo(() => ({
    push,
    dismiss,
    error: (m, o) => push('error', m, o),
    success: (m, o) => push('success', m, o),
    info: (m, o) => push('info', m, o),
    warning: (m, o) => push('warning', m, o),
  }), [push, dismiss]);

  // Bridge for components outside the provider's React tree: they can raise a
  // toast with window.dispatchEvent(new CustomEvent('toast', { detail })).
  useEffect(() => {
    const onToast = (e) => { const d = e.detail || {}; push(d.type || 'info', d.message, { title: d.title, duration: d.duration }); };
    window.addEventListener('toast', onToast);
    return () => window.removeEventListener('toast', onToast);
  }, [push]);

  const errors = toasts.filter((t) => t.type === 'error');
  const others = toasts.filter((t) => t.type !== 'error');

  const renderToast = (t) => (
    <div key={t.id} className={`toast toast-${t.type}`} role={t.type === 'error' ? 'alert' : 'status'}>
      <span className="toast-icon" aria-hidden="true">
        <Icon name={ICON[t.type] || 'details'} size={15} />
      </span>
      <div className="toast-body">
        {t.title && <div className="toast-title">{t.title}</div>}
        <div className="toast-msg">{t.message}</div>
      </div>
      {t.count > 1 && <span className="toast-count" aria-label={`repeated ${t.count} times`}>×{t.count}</span>}
      <button type="button" className="toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss">
        <Icon name="close" size={13} />
      </button>
    </div>
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" role="region" aria-label="Notifications">
        <div className="toast-group toast-group-assertive" aria-live="assertive" aria-relevant="additions">
          {errors.map(renderToast)}
        </div>
        <div className="toast-group toast-group-polite" aria-live="polite" aria-relevant="additions">
          {others.map(renderToast)}
        </div>
      </div>
    </ToastContext.Provider>
  );
}
