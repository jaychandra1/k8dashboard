import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from '../Icons';
import Button from './Button';
import useFocusTrap from '../../hooks/useFocusTrap';
import { focusables } from '../../lib/a11y';

let openCount = 0;
function lockScroll() {
  openCount += 1;
  if (openCount === 1) {
    document.body.dataset.prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
}
function unlockScroll() {
  openCount = Math.max(0, openCount - 1);
  if (openCount === 0) {
    document.body.style.overflow = document.body.dataset.prevOverflow || '';
    delete document.body.dataset.prevOverflow;
  }
}

function portalRoot() {
  if (typeof document === 'undefined') return null;
  let el = document.getElementById('modal-root');
  if (!el) {
    el = document.createElement('div');
    el.id = 'modal-root';
    document.body.appendChild(el);
  }
  return el;
}

/**
 * Accessible modal dialog rendered into #modal-root.
 *
 * <Modal open onClose title="Scale deployment" description="…" size="sm|md|lg|xl"
 *        footer={<>…buttons…</>} danger icon="scale" initialFocusRef={ref} closeOnBackdrop>
 *   body
 * </Modal>
 *
 * Class names mirror the legacy .action-modal* look: .ui-modal-backdrop,
 * .ui-modal[data-size], .ui-modal-header, .ui-modal-body, .ui-modal-footer.
 */
export default function Modal({
  open,
  onClose,
  title,
  description,
  size = 'md',
  initialFocusRef,
  children,
  footer,
  danger = false,
  icon,
  closeOnBackdrop = true,
  closeOnEscape = true,
  showClose = true,
  className = '',
  bodyClassName = '',
  ariaLabel,
}) {
  const id = useId();
  const ref = useRef(null);
  const bodyRef = useRef(null);
  const [root] = useState(portalRoot);
  // Initial focus: explicit ref → [data-autofocus] → first control in the body
  // → first control in the footer → anything (the header close button last).
  const getInitialFocus = useCallback((dialog) => {
    const body = focusables(bodyRef.current)[0];
    if (body) return body;
    const footer = focusables(dialog.querySelector('.ui-modal-footer'))[0];
    return footer || null;
  }, []);
  useFocusTrap(ref, !!open, { initialFocusRef, getInitialFocus });

  useEffect(() => {
    if (!open) return undefined;
    lockScroll();
    const onKey = (e) => {
      if (e.key === 'Escape' && closeOnEscape) { e.stopPropagation(); onClose?.(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); unlockScroll(); };
  }, [open, closeOnEscape, onClose]);

  if (!open || !root) return null;
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;

  return createPortal(
    <div
      className="ui-modal-backdrop"
      onMouseDown={(e) => { if (closeOnBackdrop && e.target === e.currentTarget) onClose?.(); }}
    >
      <div
        ref={ref}
        className={`ui-modal ${className}`.trim()}
        data-size={size}
        data-danger={danger || undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={!title ? ariaLabel : undefined}
        aria-describedby={description ? descId : undefined}
      >
        {(title || showClose) && (
          <div className="ui-modal-header">
            {icon && <span className="ui-modal-icon" aria-hidden="true"><Icon name={icon} size={17} /></span>}
            {title && <h2 id={titleId} className="ui-modal-title">{title}</h2>}
            {showClose && onClose && (
              <Button variant="ghost" size="sm" iconOnly icon="close" ariaLabel="Close dialog" className="ui-modal-close" onClick={onClose} />
            )}
          </div>
        )}
        {description && <p id={descId} className="ui-modal-desc">{description}</p>}
        <div ref={bodyRef} className={`ui-modal-body ${bodyClassName}`.trim()}>{children}</div>
        {footer && <div className="ui-modal-footer">{footer}</div>}
      </div>
    </div>,
    root,
  );
}

export { Modal };

/**
 * Confirm dialog.
 * <ConfirmModal open title="Delete pod" message={<>Delete <b>{name}</b>?</>}
 *   confirmLabel="Delete" danger busy requireTyped={name} onConfirm onCancel />
 */
export function ConfirmModal({
  open,
  title = 'Are you sure?',
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  busy = false,
  requireTyped,
  icon,
  onConfirm,
  onCancel,
  children,
}) {
  const [typed, setTyped] = useState('');
  const inputRef = useRef(null);
  const confirmRef = useRef(null);
  const typedId = useId();
  useEffect(() => { if (open) setTyped(''); }, [open]);
  const ok = !requireTyped || typed === requireTyped;

  const submit = (e) => {
    e?.preventDefault?.();
    if (!ok || busy) return;
    onConfirm?.();
  };

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onCancel}
      title={title}
      danger={danger}
      icon={icon || (danger ? 'warning' : undefined)}
      size="sm"
      initialFocusRef={requireTyped ? inputRef : confirmRef}
      closeOnBackdrop={!busy}
      footer={(
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>{cancelLabel}</Button>
          <Button ref={confirmRef} variant={danger ? 'danger' : 'primary'} onClick={submit} disabled={!ok} busy={busy}>{confirmLabel}</Button>
        </>
      )}
    >
      <form onSubmit={submit}>
        {message && <p className="ui-modal-text">{message}</p>}
        {children}
        {requireTyped && (
          <>
            <label htmlFor={typedId} className="ui-modal-label">Type <code>{requireTyped}</code> to confirm</label>
            <input
              ref={inputRef}
              id={typedId}
              className="ui-modal-input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={typed.length > 0 && !ok ? 'true' : undefined}
            />
          </>
        )}
      </form>
    </Modal>
  );
}
