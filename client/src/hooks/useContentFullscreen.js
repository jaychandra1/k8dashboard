import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react';

/**
 * "Full screen" for a panel inside a page: while on, the panel is pinned
 * (position: fixed) over the app's content area — <main id="main">,
 * everything right of the sidebar and below the top bar — so the sidebar and
 * top bar stay visible and usable. The pinned box follows the area when the
 * window, sidebar or top bar change size. Escape turns it off unless a dialog
 * or menu on top owns the key, or focus is in a text editor / the terminal
 * (where Escape means something else).
 *
 *   const fs = useContentFullscreen();
 *   <div className={fs.on ? 'panel is-fullscreen' : 'panel'} style={fs.style}>…</div>
 *   <button onClick={fs.toggle}>…</button>
 *
 * `style` sets top / left / height and `--fs-width` (the area's width); the
 * CSS sizes the box from it, so a panel can leave room for a drawer.
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
      // The YAML editor and the pod terminal (xterm's input is a textarea) use Escape themselves.
      if (e.target?.closest?.('textarea, [contenteditable="true"], .xterm')) return;
      setOn(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [on]);

  const toggle = useCallback(() => setOn((v) => !v), []);
  const exit = useCallback(() => setOn(false), []);
  const style = useMemo(
    () =>
      on && rect
        ? { top: rect.top, left: rect.left, height: rect.height, '--fs-width': `${rect.width}px` }
        : undefined,
    [on, rect]
  );
  return useMemo(() => ({ on, toggle, exit, style }), [on, toggle, exit, style]);
}

/** Full-screen state shared by a bottom panel (ui/BottomPanel) with the viewers inside it. */
export const FullscreenContext = createContext(null);

/**
 * Full screen for a viewer (logs, YAML, terminal). Inside a <BottomPanel> it
 * is the panel's state — the whole panel, tab strip included, goes full
 * screen (`inPanel: true`, the viewer styles nothing itself). Elsewhere the
 * viewer gets its own state and applies `style` / an `is-fullscreen` class.
 */
export function usePanelFullscreen() {
  const panel = useContext(FullscreenContext);
  const own = useContentFullscreen();
  return useMemo(() => (panel ? { ...panel, inPanel: true } : { ...own, inPanel: false }), [panel, own]);
}
