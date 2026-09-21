import { afterPaint } from '../../lib/a11y';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from '../Icons';

/**
 * Accessible context / dropdown menu.
 *
 *   <Menu open x={e.clientX} y={e.clientY} onClose={…} items={[
 *     { label: 'Logs', icon: 'logs', onSelect() {} },
 *     { label: 'Scale…', icon: 'scale', onSelect() {}, disabled: true },
 *     { divider: true },
 *     { label: 'Copy', icon: 'copy', children: [{ label: 'Name', onSelect() {} }] },
 *     { label: 'Delete', icon: 'delete', danger: true, onSelect() {} },
 *   ]} />
 *
 * Or imperatively: `Menu.open({ x, y, items, returnFocusTo })` → { close }.
 * Keyboard: Arrow Up/Down, Home/End, Enter/Space, ArrowRight opens submenu,
 * ArrowLeft/Escape closes, typeahead by first letters.
 */
const SUB_W = 200;

function MenuList({ items, onClose, onSelectDone, x, y, level = 0, anchorRect, flipHint, labelledBy, ariaLabel, autoFocus = true }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [flip, setFlip] = useState(!!flipHint);
  const [active, setActive] = useState(-1);
  const [openSub, setOpenSub] = useState(null);
  const typeahead = useRef({ buf: '', t: null });
  const closeTimer = useRef(null);

  const enabled = useMemo(() => items.map((it, i) => ({ it, i })).filter(({ it }) => !it.divider && !it.disabled), [items]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let left = x; let top = y;
    if (anchorRect) {
      // submenu: to the right of the parent item, flipping when near the edge
      left = flip ? anchorRect.left - rect.width - 2 : anchorRect.right + 2;
      top = anchorRect.top - 5;
      if (!flip && left + rect.width > window.innerWidth - 8) { left = anchorRect.left - rect.width - 2; setFlip(true); }
    }
    if (left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8;
    if (top + rect.height > window.innerHeight - 8) top = Math.max(8, (anchorRect ? window.innerHeight - 8 : y) - rect.height);
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
    if (!anchorRect) setFlip(left + rect.width + SUB_W > window.innerWidth - 8);
  }, [x, y, anchorRect, flip]);

  useEffect(() => {
    if (!autoFocus) return;
    const first = enabled[0]?.i ?? -1;
    setActive(first);
    afterPaint(() => ref.current?.focus({ preventScroll: true }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const move = (delta) => {
    if (!enabled.length) return;
    const cur = enabled.findIndex(({ i }) => i === active);
    const next = ((cur < 0 ? (delta > 0 ? -1 : 0) : cur) + delta + enabled.length) % enabled.length;
    setActive(enabled[next].i);
  };

  const select = (item) => {
    if (!item || item.disabled || item.divider) return;
    if (item.children?.length) { setOpenSub(item); return; }
    onSelectDone?.();
    item.onSelect?.();
    item.onClick?.(); // legacy ContextMenu items
  };

  const onKeyDown = (e) => {
    const item = items[active];
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); e.stopPropagation(); move(1); break;
      case 'ArrowUp': e.preventDefault(); e.stopPropagation(); move(-1); break;
      case 'Home': e.preventDefault(); e.stopPropagation(); if (enabled.length) setActive(enabled[0].i); break;
      case 'End': e.preventDefault(); e.stopPropagation(); if (enabled.length) setActive(enabled[enabled.length - 1].i); break;
      case 'Enter': case ' ': e.preventDefault(); e.stopPropagation(); select(item); break;
      case 'ArrowRight': if (item?.children?.length) { e.preventDefault(); e.stopPropagation(); setOpenSub(item); } break;
      case 'ArrowLeft': if (level > 0) { e.preventDefault(); e.stopPropagation(); onClose?.('back'); } break;
      case 'Escape': e.preventDefault(); e.stopPropagation(); onClose?.('escape'); break;
      case 'Tab': e.preventDefault(); onClose?.('tab'); break;
      default: {
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const ta = typeahead.current;
          clearTimeout(ta.t);
          ta.buf += e.key.toLowerCase();
          ta.t = setTimeout(() => { ta.buf = ''; }, 500);
          const start = enabled.findIndex(({ i }) => i === active);
          const order = enabled.slice(start + 1).concat(enabled.slice(0, start + 1));
          const hit = order.find(({ it }) => String(it.label || '').toLowerCase().startsWith(ta.buf));
          if (hit) setActive(hit.i);
        }
      }
    }
  };

  const subAnchor = openSub ? ref.current?.querySelector(`[data-idx="${items.indexOf(openSub)}"]`)?.getBoundingClientRect() : null;
  const hoverOpen = (item) => { clearTimeout(closeTimer.current); if (item.children?.length && !item.disabled) setOpenSub(item); else setOpenSub(null); };
  const hoverLeave = () => { closeTimer.current = setTimeout(() => setOpenSub(null), 220); };

  return (
    <>
      <div
        ref={ref}
        className="ui-menu context-menu"
        role="menu"
        tabIndex={-1}
        aria-labelledby={labelledBy}
        aria-label={ariaLabel}
        data-level={level}
        style={{ left: pos.left, top: pos.top }}
        onKeyDown={onKeyDown}
        onMouseLeave={hoverLeave}
        onMouseEnter={() => clearTimeout(closeTimer.current)}
      >
        {items.map((item, i) => {
          if (item.divider) return <div key={`d${i}`} className="context-menu-divider ui-menu-divider" role="separator" />;
          const hasSub = !!item.children?.length;
          const isActive = i === active;
          return (
            <button
              key={item.key || item.label || i}
              type="button"
              role={item.checked != null ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={item.checked != null ? !!item.checked : undefined}
              aria-haspopup={hasSub ? 'menu' : undefined}
              aria-expanded={hasSub ? openSub === item : undefined}
              aria-disabled={item.disabled || undefined}
              data-idx={i}
              tabIndex={-1}
              className={`context-menu-item ui-menu-item${item.danger ? ' danger' : ''}${isActive ? ' active' : ''}${item.disabled ? ' disabled' : ''}`}
              onMouseEnter={() => { setActive(i); hoverOpen(item); }}
              onClick={(e) => { e.stopPropagation(); if (item.disabled) return; select(item); }}
            >
              {item.icon && <Icon name={item.icon} size={15} />}
              <span className="context-menu-label">{item.label}</span>
              {item.hint && <span className="ui-menu-hint">{item.hint}</span>}
              {hasSub && <span className="context-menu-caret" aria-hidden="true"><Icon name="chevronRight" size={13} strokeWidth={2.2} /></span>}
            </button>
          );
        })}
      </div>
      {openSub && subAnchor && (
        <MenuList
          items={openSub.children}
          level={level + 1}
          x={subAnchor.right}
          y={subAnchor.top}
          anchorRect={subAnchor}
          flipHint={flip}
          ariaLabel={openSub.label}
          onSelectDone={onSelectDone}
          onClose={(why) => { setOpenSub(null); if (why === 'escape' || why === 'tab') onClose?.(why); else ref.current?.focus(); }}
        />
      )}
    </>
  );
}

export default function Menu({ open = true, x = 0, y = 0, items = [], onClose, returnFocusTo, ariaLabel = 'Actions', labelledBy }) {
  const prev = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    prev.current = returnFocusTo || document.activeElement;
    const onDown = (e) => { if (!e.target.closest?.('.ui-menu')) onClose?.('outside'); };
    const onScroll = () => onClose?.('scroll');
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onScroll);
      const el = prev.current;
      if (el && typeof el.focus === 'function' && document.contains(el)) { try { el.focus({ preventScroll: true }); } catch { /* ignore */ } }
    };
  }, [open, onClose, returnFocusTo]);

  const done = useCallback(() => onClose?.('select'), [onClose]);
  if (!open || typeof document === 'undefined') return null;
  const root = document.getElementById('modal-root') || document.body;
  return createPortal(
    <MenuList items={items} x={x} y={y} onClose={onClose} onSelectDone={done} ariaLabel={ariaLabel} labelledBy={labelledBy} />,
    root,
  );
}

export { Menu };

/**
 * Imperative opener for non-React call sites (or to avoid threading state):
 *   const h = Menu.open({ x, y, items, returnFocusTo: buttonEl }); h.close();
 * Returns a handle with `close()`. Uses a dedicated React root under #modal-root.
 */
Menu.open = function open({ x, y, items, returnFocusTo, ariaLabel }) {
  // Lazy import keeps react-dom/client out of module scope for SSR/tests.
  return import('react-dom/client').then(({ createRoot }) => {
    const host = document.createElement('div');
    (document.getElementById('modal-root') || document.body).appendChild(host);
    const root = createRoot(host);
    let closed = false;
    const close = () => {
      if (closed) return; closed = true;
      root.unmount();
      host.remove();
    };
    root.render(<Menu open x={x} y={y} items={items} returnFocusTo={returnFocusTo} ariaLabel={ariaLabel} onClose={close} />);
    return { close };
  });
};
