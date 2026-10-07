import { useCallback, useEffect, useLayoutEffect, useState } from 'react';

/**
 * "Full screen" for a panel inside a page (e.g. the logs viewer): while on,
 * the panel is pinned (position: fixed) over the app's content area —
 * <main id="main">, everything right of the sidebar and below the top bar —
 * so the sidebar and top bar stay visible and usable. The pinned box follows
 * the area when the window, sidebar or top bar change size. Escape turns it
 * off unless a dialog or menu on top owns the key.
 *
 *   const fs = useContentFullscreen();
 *   <div className={fs.on ? 'panel is-fullscreen' : 'panel'} style={fs.style}>…</div>
 *   <button onClick={fs.toggle} aria-pressed={fs.on}>…</button>
 */
export default function useContentFullscreen(areaId = 'main') {
  const [on, setOn] = useState(false);
  const [rect, setRect] = useState(null);

  useLayoutEffect(() => {
    if (!on) {
      setRect(null);
      return undefined;
    }
    const area = document.getElementById(areaId);
    if (!area) return undefined; // no content area → the CSS fallback (whole window) applies
    const measure = () => {
      const r = area.getBoundingClientRect();
      setRect((prev) =>
        prev &&
        prev.top === r.top &&
        prev.left === r.left &&
        prev.width === r.width &&
        prev.height === r.height
          ? prev
          : { top: r.top, left: r.left, width: r.width, height: r.height }
      );
    };
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(area);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [on, areaId]);

  useEffect(() => {
    if (!on) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('.ui-modal-backdrop, [role="menu"], [role="tooltip"]')) return;
      setOn(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [on]);

  const toggle = useCallback(() => setOn((v) => !v), []);
  const exit = useCallback(() => setOn(false), []);
  const style =
    on && rect ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height } : undefined;
  return { on, toggle, exit, style };
}
