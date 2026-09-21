// Screen-reader announcements via a persistent live region (see index.html
// #live-region; created lazily if missing so tests and the Electron shell work).

/**
 * Run `fn` after the next paint. Falls back to a macrotask when
 * requestAnimationFrame does not fire (background tabs, unpainted windows),
 * so focus management never silently stalls. Returns a cancel function.
 */
export function afterPaint(fn) {
  let done = false;
  const run = () => { if (done) return; done = true; fn(); };
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : null;
  const timer = setTimeout(run, 32);
  return () => { done = true; if (raf != null) cancelAnimationFrame(raf); clearTimeout(timer); };
}

export const srOnly = 'sr-only';

const REGION_ID = 'live-region';

function region(politeness) {
  if (typeof document === 'undefined') return null;
  let root = document.getElementById(REGION_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = REGION_ID;
    root.className = srOnly;
    document.body.appendChild(root);
  }
  const id = `${REGION_ID}-${politeness}`;
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.setAttribute('aria-live', politeness);
    el.setAttribute('aria-atomic', 'true');
    el.setAttribute('role', politeness === 'assertive' ? 'alert' : 'status');
    root.appendChild(el);
  }
  return el;
}

let clearTimer = null;

/**
 * Announce a message to assistive tech.
 * @param {string} msg
 * @param {'polite'|'assertive'} [politeness='polite']
 */
export function announce(msg, politeness = 'polite') {
  const el = region(politeness === 'assertive' ? 'assertive' : 'polite');
  if (!el || !msg) return;
  // Clear first so an identical message is re-announced.
  el.textContent = '';
  // Next tick so the DOM mutation is observed as a change.
  setTimeout(() => { el.textContent = String(msg); }, 30);
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => { el.textContent = ''; }, 5000);
}

/** Focusable-element selector shared by the focus trap and menus. */
export const FOCUSABLE = [
  'a[href]', 'area[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', 'iframe', 'object', 'embed',
  '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])',
].join(',');

function isVisible(el, root) {
  // Walk up to the root checking display/visibility (offsetParent is unreliable
  // for fixed elements and is always null in jsdom).
  let n = el;
  while (n && n !== root.parentElement) {
    if (n.hidden) return false;
    const cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    n = n.parentElement;
  }
  return true;
}

export function focusables(root) {
  if (!root) return [];
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => el.getAttribute('aria-hidden') !== 'true' && isVisible(el, root));
}

/** Stable ids for aria-labelledby / aria-describedby. */
let seq = 0;
export function uid(prefix = 'ui') {
  seq += 1;
  return `${prefix}-${seq}`;
}
