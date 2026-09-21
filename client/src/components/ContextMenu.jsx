import { useCallback } from 'react';
import Menu from './ui/Menu';

/**
 * Compatibility wrapper over the foundation `<Menu>`: same props as the old
 * hand-rolled context menu (`x, y, items, onClose`), so ResourceViewer / Nodes /
 * ArgoCD keep working unchanged. Items may use `onClick` (legacy) or
 * `onSelect`, plus `icon`, `danger`, `disabled`, `divider`, `children`.
 *
 * Gains: role="menu"/"menuitem", Arrow/Home/End/Escape/typeahead keyboard
 * support, keyboard-openable submenus, focus restore.
 */
export default function ContextMenu({ x, y, items = [], onClose, ariaLabel = 'Actions', returnFocusTo }) {
  const close = useCallback(() => onClose?.(), [onClose]);
  return <Menu open x={x} y={y} items={items} onClose={close} ariaLabel={ariaLabel} returnFocusTo={returnFocusTo} />;
}

export { ContextMenu };
