import { useCallback, useEffect, useRef, useState } from 'react';
import { afterPaint, focusables } from '../../lib/a11y';

const QUERY = '(max-width: 1024px)';

// Responsive sidebar state. Under 1024px the sidebar is an off-canvas drawer:
// `.app-shell[data-nav="open"|"collapsed"]`, toggled from the TopBar
// `.nav-toggle`, closed by the backdrop / Escape / navigation. Focus moves into
// the nav when it opens and returns to the toggle when it closes.
//
//   const drawer = useNavDrawer({ routeKey: route.view });
//   <div className="app-shell" data-nav={drawer.navState}> … <nav ref={drawer.navRef} id="primary-nav">
export default function useNavDrawer({ routeKey } = {}) {
  const [narrow, setNarrow] = useState(() => {
    try { return !!window.matchMedia?.(QUERY).matches; } catch { return false; }
  });
  const [open, setOpen] = useState(false);
  const toggleRef = useRef(null);
  const navRef = useRef(null);
  const hadFocus = useRef(false);

  useEffect(() => {
    let mq;
    try { mq = window.matchMedia?.(QUERY); } catch { mq = null; }
    if (!mq) return undefined;
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener?.('change', onChange);
    // Some embedded/emulated viewports resize without dispatching a
    // MediaQueryList 'change' event; re-evaluate on window resize too.
    window.addEventListener('resize', onChange);
    return () => { mq.removeEventListener?.('change', onChange); window.removeEventListener('resize', onChange); };
  }, []);

  // Close on navigation.
  useEffect(() => { setOpen(false); }, [routeKey]);

  const isOpen = narrow && open;
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('keydown', onKey);
    const toggleEl = toggleRef.current; // captured now: the toggle outlives the drawer
    const cancelFocus = afterPaint(() => {
      const root = navRef.current;
      const first = root ? focusables(root)[0] : null;
      if (first) { hadFocus.current = true; try { first.focus({ preventScroll: true }); } catch { /* ignore */ } }
    });
    return () => {
      document.removeEventListener('keydown', onKey);
      cancelFocus();
      if (hadFocus.current) {
        hadFocus.current = false;
        if (toggleEl && document.contains(toggleEl)) { try { toggleEl.focus({ preventScroll: true }); } catch { /* ignore */ } }
      }
    };
  }, [isOpen]);

  const toggle = useCallback(() => setOpen((o) => !o), []);
  const close = useCallback(() => setOpen(false), []);

  return {
    narrow,
    open: isOpen,
    navState: narrow ? (open ? 'open' : 'collapsed') : undefined,
    toggle,
    close,
    toggleRef,
    navRef,
  };
}

export { useNavDrawer };
