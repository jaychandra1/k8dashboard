import { useCallback, useEffect, useRef, useState } from 'react';
import Menu from './ui/Menu';

// The window's title bar, where the app draws it: the desktop app on Windows
// (window.k8boardHost.titleBar). One slim bar takes the place of the native
// title bar and the menu row under it:
//
//   [icon] View  Clusters  Window  Help        <window title>        [ – ▢ ✕ ]
//
// The menus are the application menu's own: the desktop shell describes it
// (k8boardHost.menu()) and is told which item was chosen (menuClick(id)), so an
// item does exactly what it does in a native menu and its shortcut keeps
// working. Windows draws the caption buttons over the bar's right end; the bar
// tells the shell its two colours (chrome()) so they match the theme. The bar
// is the window's drag region; the menu buttons are not.
//
// In a browser, on macOS and on Linux there is no such bar: hasTitleBar() is false.

const host = () => (typeof window !== 'undefined' ? window.k8boardHost : undefined);
export const hasTitleBar = () => !!host()?.titleBar;

/** The shell's menu description → items for <Menu>. */
export function toMenuItems(entries, choose) {
  return (entries || []).map((e) => {
    if (e.type === 'separator') return { divider: true };
    const item = { key: e.id, label: e.label, disabled: e.enabled === false, hint: e.accelerator || undefined };
    if (e.type === 'checkbox' || e.type === 'radio') item.checked = !!e.checked;
    if (e.submenu) item.children = toMenuItems(e.submenu, choose);
    else item.onSelect = () => choose(e.id);
    return item;
  });
}

/** "rgb(11, 12, 14)" / "rgba(…)" → "#0b0c0e"; null for anything else. */
export function toHex(color) {
  const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(String(color || ''));
  if (!m) return null;
  return `#${m.slice(1, 4).map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('')}`;
}

export default function TitleBar({ title = '' }) {
  const [menus, setMenus] = useState([]);
  const [open, setOpen] = useState(null); // { index, x, y }
  const barRef = useRef(null);
  const buttons = useRef([]);
  // A press on the open menu's own button: the menu's outside-press handler has
  // already closed it, so the click that follows must not open it again.
  const wasOpenOnDown = useRef(false);

  const load = useCallback(() => {
    Promise.resolve(host()?.menu?.())
      .then((m) => setMenus(Array.isArray(m) ? m.filter((x) => x && x.type === 'submenu') : []))
      .catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  // The caption buttons Windows draws over the bar take its colours, now and
  // whenever the theme changes (App sets data-theme on <html>).
  useEffect(() => {
    const tell = () => {
      const el = barRef.current;
      if (!el) return;
      const cs = getComputedStyle(el);
      const color = toHex(cs.backgroundColor);
      const symbolColor = toHex(cs.color);
      if (color && symbolColor) host()?.chrome?.(color, symbolColor);
    };
    tell();
    const seen = new MutationObserver(tell);
    seen.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => seen.disconnect();
  }, []);

  const openAt = useCallback((index) => {
    const r = buttons.current[index]?.getBoundingClientRect?.();
    setOpen({ index, x: r ? r.left : 0, y: r ? r.bottom + 2 : 0 });
    load(); // an item's enabled state may have changed since the bar was drawn
  }, [load]);
  const close = useCallback(() => setOpen(null), []);
  const choose = useCallback((id) => { Promise.resolve(host()?.menuClick?.(id)).catch(() => {}); }, []);

  const onKeyDown = (e, index) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAt(index); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = (index + (e.key === 'ArrowRight' ? 1 : menus.length - 1)) % menus.length;
      buttons.current[next]?.focus();
    }
  };

  const current = open ? menus[open.index] : null;
  return (
    <div className="titlebar" ref={barRef}>
      <img className="titlebar-icon" src="/logo-mark.png" alt="" width="16" height="16" decoding="async" />
      <div className="titlebar-menus" role="menubar" aria-label="Application menu">
        {menus.map((m, i) => (
          <button
            key={m.id}
            ref={(el) => { buttons.current[i] = el; }}
            type="button"
            role="menuitem"
            className="titlebar-menu"
            aria-haspopup="menu"
            aria-expanded={open?.index === i}
            onMouseDown={() => { wasOpenOnDown.current = open?.index === i; }}
            onClick={() => {
              if (wasOpenOnDown.current) { wasOpenOnDown.current = false; return; }
              if (open?.index === i) close(); else openAt(i);
            }}
            // With one menu open, moving along the bar opens the next (as a menu bar does).
            onMouseEnter={() => { if (open && open.index !== i) openAt(i); }}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="titlebar-title" aria-hidden="true">{title}</div>
      {current && (
        <Menu
          key={current.id}
          open
          x={open.x}
          y={open.y}
          items={toMenuItems(current.submenu, choose)}
          onClose={close}
          returnFocusTo={buttons.current[open.index]}
          ariaLabel={current.label}
        />
      )}
    </div>
  );
}
