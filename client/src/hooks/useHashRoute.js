// Hash router: `#/<view>[/<param>...]?key=value`
//
//   const { route, navigate, back, forward, canBack, canForward } = useHashRoute();
//   route            → { view: 'pod', params: ['kube-system', 'coredns-abc'], query: { tab: 'logs' } }
//   navigate('pod', ['kube-system'], { tab: 'logs' })         push
//   navigate('pod', [], {}, { replace: true })                replace
//
// `canBack`/`canForward` come from an in-memory index kept in history.state
// (so they survive reloads within the session and stay accurate when the user
// uses the browser/Electron back buttons).
import { useCallback, useEffect, useMemo, useState } from 'react';

export const DEFAULT_VIEW = 'overview';

const enc = (s) => encodeURIComponent(String(s));
const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

/** '#/pod/ns/name?tab=logs' → { view, params, query } (pure). */
export function parseHash(hash) {
  let h = String(hash || '');
  if (h.startsWith('#')) h = h.slice(1);
  if (h.startsWith('/')) h = h.slice(1);
  const qi = h.indexOf('?');
  const pathPart = qi >= 0 ? h.slice(0, qi) : h;
  const queryPart = qi >= 0 ? h.slice(qi + 1) : '';
  const segs = pathPart.split('/').filter(Boolean).map(dec);
  const query = {};
  if (queryPart) {
    for (const pair of queryPart.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const k = dec(eq >= 0 ? pair.slice(0, eq) : pair);
      const v = eq >= 0 ? dec(pair.slice(eq + 1)) : '';
      if (k) query[k] = v;
    }
  }
  return { view: segs[0] || DEFAULT_VIEW, params: segs.slice(1), query };
}

/** { view, params, query } → '#/view/p1/p2?k=v' (pure). */
export function buildHash(view, params = [], query = {}) {
  const segs = [view || DEFAULT_VIEW, ...(params || [])].filter((s) => s !== undefined && s !== null && s !== '').map(enc);
  const q = Object.entries(query || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${enc(k)}=${enc(v)}`)
    .join('&');
  return `#/${segs.join('/')}${q ? `?${q}` : ''}`;
}

const sameRoute = (a, b) => buildHash(a.view, a.params, a.query) === buildHash(b.view, b.params, b.query);

// Module-level history index so multiple hook instances agree.
let stack = [];
let idx = -1;
const listeners = new Set();
const notify = () => listeners.forEach((l) => l());

function currentHash() {
  return typeof location !== 'undefined' ? location.hash : '';
}

function historyIdx(st) {
  if (!st) return undefined;
  if (typeof st.k8dashboardIdx === 'number') return st.k8dashboardIdx;
  if (typeof st.k8sightIdx === 'number') return st.k8sightIdx;
  return undefined;
}

function ensureIndexed() {
  const h = currentHash() || buildHash(DEFAULT_VIEW);
  const st = typeof history !== 'undefined' ? history.state : null;
  const stored = historyIdx(st);
  if (typeof stored === 'number' && stack[stored] === h) {
    idx = stored;
    return;
  }
  // Unknown entry (fresh load, external hash change): append.
  if (idx >= 0 && stack[idx] === h) return;
  stack = stack.slice(0, idx + 1).concat(h);
  idx = stack.length - 1;
  try { history.replaceState({ ...(history.state || {}), k8dashboardIdx: idx }, ''); } catch { /* ignore */ }
}

function onHashChange() {
  ensureIndexed();
  notify();
}

let bound = false;
function bind() {
  if (typeof window === 'undefined') return;
  if (!bound) {
    bound = true;
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('popstate', onHashChange);
  }
  if (idx < 0) ensureIndexed();
}

/** Programmatic navigation usable outside React (e.g. from lib code). */
export function navigateTo(view, params, query, { replace = false } = {}) {
  bind();
  const next = buildHash(view, params, query);
  const cur = currentHash();
  if (next === cur) return;
  if (replace) {
    stack[idx] = next;
    try { history.replaceState({ ...(history.state || {}), k8dashboardIdx: idx }, '', next); } catch { location.hash = next; }
    notify();
    return;
  }
  stack = stack.slice(0, idx + 1).concat(next);
  idx = stack.length - 1;
  try { history.pushState({ k8dashboardIdx: idx }, '', next); } catch { location.hash = next; }
  // pushState doesn't fire hashchange; notify manually.
  notify();
}

/** Test helper: reset the module-level index. */
export function _resetHistoryIndex() { stack = []; idx = -1; }
export function _historyIndex() { return { stack: stack.slice(), idx }; }

export default function useHashRoute() {
  const [, force] = useState(0);
  useEffect(() => {
    bind();
    const l = () => force((n) => n + 1);
    listeners.add(l);
    // In case the hash changed between render and subscribe.
    l();
    return () => listeners.delete(l);
  }, []);

  const hash = currentHash();
  const route = useMemo(() => parseHash(hash), [hash]);

  const navigate = useCallback((view, params, query, opts) => navigateTo(view, params, query, opts), []);
  const back = useCallback(() => { if (idx > 0) history.back(); }, []);
  const forward = useCallback(() => { if (idx < stack.length - 1) history.forward(); }, []);

  return {
    route,
    hash,
    navigate,
    back,
    forward,
    canBack: idx > 0,
    canForward: idx >= 0 && idx < stack.length - 1,
    /** Replace only the query (keeps view + params). */
    setQuery: useCallback((patch, opts = { replace: true }) => {
      const r = parseHash(currentHash());
      navigateTo(r.view, r.params, { ...r.query, ...patch }, opts);
    }, []),
    isSame: useCallback((other) => sameRoute(parseHash(currentHash()), other), []),
  };
}

export { useHashRoute };
