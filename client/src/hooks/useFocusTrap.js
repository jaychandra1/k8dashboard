import { useEffect } from 'react';
import { afterPaint, focusables } from '../lib/a11y';

/**
 * Trap Tab/Shift+Tab inside `ref` while `active`. On activate, focuses
 * `[data-autofocus]` (or `initialFocusRef.current`, or the first focusable, or
 * the container). On deactivate, restores focus to the previously focused element.
 */
export default function useFocusTrap(ref, active, { initialFocusRef, getInitialFocus, restoreFocus = true } = {}) {
  useEffect(() => {
    if (!active) return undefined;
    const root = ref.current;
    if (!root) return undefined;
    const previouslyFocused = typeof document !== 'undefined' ? document.activeElement : null;

    const initial = initialFocusRef?.current
      || root.querySelector('[data-autofocus]')
      || (getInitialFocus ? getInitialFocus(root) : null)
      || focusables(root)[0]
      || root;
    if (initial && !root.hasAttribute('tabindex') && initial === root) root.setAttribute('tabindex', '-1');
    // Defer so the element is laid out (portals / animations).
    const cancelFocus = afterPaint(() => { try { initial.focus({ preventScroll: true }); } catch { /* ignore */ } });

    const onKeyDown = (e) => {
      if (e.key !== 'Tab') return;
      const items = focusables(root);
      if (items.length === 0) { e.preventDefault(); root.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const activeEl = document.activeElement;
      if (e.shiftKey) {
        if (activeEl === first || !root.contains(activeEl)) { e.preventDefault(); last.focus(); }
      } else if (activeEl === last || !root.contains(activeEl)) { e.preventDefault(); first.focus(); }
    };
    // If focus escapes (e.g. programmatic), pull it back.
    const onFocusIn = (e) => {
      if (!root.contains(e.target)) {
        const items = focusables(root);
        (items[0] || root).focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      cancelFocus();
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn);
      if (restoreFocus && previouslyFocused && typeof previouslyFocused.focus === 'function' && document.contains(previouslyFocused)) {
        try { previouslyFocused.focus({ preventScroll: true }); } catch { /* ignore */ }
      }
    };
  }, [ref, active, initialFocusRef, getInitialFocus, restoreFocus]);
}

export { useFocusTrap };
