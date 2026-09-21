import React, { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Accessible tooltip: shows on hover AND focus, is linked via aria-describedby,
 * and dismisses with Escape. Wrap exactly one focusable child.
 *
 *   <Tooltip content="Delete pod"><Button iconOnly icon="delete" ariaLabel="Delete" /></Tooltip>
 */
export default function Tooltip({ content, children, placement = 'top', delay = 250 }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const anchor = useRef(null);
  const tipRef = useRef(null);
  const timer = useRef(null);

  const show = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(true), delay); };
  const hide = () => { clearTimeout(timer.current); setOpen(false); };

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') hide(); };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !anchor.current || !tipRef.current) return;
    const a = anchor.current.getBoundingClientRect();
    const t = tipRef.current.getBoundingClientRect();
    const gap = 8;
    let top; let left;
    if (placement === 'bottom') { top = a.bottom + gap; left = a.left + a.width / 2 - t.width / 2; }
    else if (placement === 'left') { top = a.top + a.height / 2 - t.height / 2; left = a.left - t.width - gap; }
    else if (placement === 'right') { top = a.top + a.height / 2 - t.height / 2; left = a.right + gap; }
    else { top = a.top - t.height - gap; left = a.left + a.width / 2 - t.width / 2; }
    left = Math.max(8, Math.min(left, window.innerWidth - t.width - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - t.height - 8));
    setPos({ top, left });
  }, [open, placement]);

  const child = React.Children.only(children);
  const trigger = cloneElement(child, {
    ref: (el) => {
      anchor.current = el;
      const r = child.ref;
      if (typeof r === 'function') r(el); else if (r && typeof r === 'object') r.current = el;
    },
    'aria-describedby': open ? [child.props['aria-describedby'], id].filter(Boolean).join(' ') : child.props['aria-describedby'],
    onMouseEnter: (e) => { child.props.onMouseEnter?.(e); show(); },
    onMouseLeave: (e) => { child.props.onMouseLeave?.(e); hide(); },
    onFocus: (e) => { child.props.onFocus?.(e); show(); },
    onBlur: (e) => { child.props.onBlur?.(e); hide(); },
  });

  if (!content) return child;
  const root = typeof document !== 'undefined' ? (document.getElementById('modal-root') || document.body) : null;
  return (
    <>
      {trigger}
      {open && root && createPortal(
        <div ref={tipRef} id={id} role="tooltip" className="ui-tooltip" data-placement={placement}
          style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? 'visible' : 'hidden' }}>
          {content}
        </div>,
        root,
      )}
    </>
  );
}

export { Tooltip };
