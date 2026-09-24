import React, { useCallback, useMemo, useRef, useState } from 'react';
import Icon from './Icons';
import Menu from './ui/Menu';
import Tooltip from './ui/Tooltip';
import { PROVIDERS, providerKeyOf } from './ContextPickerModal';

// Compact cluster switcher in the top bar — the ONE place to change cluster
// (the sidebar no longer has a context selector).
//
// Button: provider icon + current context name (ellipsised). Menu (ui/Menu):
//   pinned clusters (✓ on the current one; selecting switches context)
//   ────────
//   All contexts                 ≤ MAX_INLINE contexts: group heading + every
//     <ctx> (provider icon, ✓)     context inline · more: an "All contexts ▸" submenu
//   Search contexts…             → the searchable ContextPickerModal
//   ────────
//   Pin / Unpin "<current>"
//   Add cluster ▸                → AWS EKS · Azure AKS
//
// The desktop app mirrors the pinned list in its native "Clusters" menu; both
// read the pins from /api/settings/pins (see shell/usePins.js).
export const MAX_INLINE = 12;

function ClusterSwitcher({
  contexts = [], contextsInfo, currentContext, pins = [],
  onSwitch, onTogglePin, onOpenContexts, onAddAws, onAddAzure,
}) {
  const btnRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  // Clicking the trigger while the menu is open: the menu's outside-mousedown
  // handler already closed it, so the follow-up click must not reopen it.
  const wasOpenOnDown = useRef(false);

  const providerOf = useMemo(() => {
    const m = new Map();
    (contextsInfo || []).forEach((c) => m.set(c.name, providerKeyOf(c.provider)));
    return (name) => m.get(name) || 'other';
  }, [contextsInfo]);
  const currentKey = providerOf(currentContext);
  const currentP = PROVIDERS[currentKey] || PROVIDERS.other;

  // Only pins that still exist in the kubeconfig (plus the active one).
  const known = useMemo(() => new Set(contexts), [contexts]);
  const pinned = useMemo(() => pins.filter((p) => known.has(p) || p === currentContext), [pins, known, currentContext]);
  const isPinned = !!currentContext && pins.includes(currentContext);
  const sorted = useMemo(() => [...contexts].sort((a, b) => a.localeCompare(b)), [contexts]);

  const openMenu = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect?.();
    setPos({ x: r ? r.left : 0, y: r ? r.bottom + 4 : 0 });
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);

  const items = useMemo(() => {
    const ctxItem = (ctx, prefix) => ({
      key: `${prefix}:${ctx}`,
      label: ctx,
      icon: (PROVIDERS[providerOf(ctx)] || PROVIDERS.other).icon,
      checked: ctx === currentContext,
      onSelect: () => { if (ctx !== currentContext) onSwitch?.(ctx); },
    });

    const list = pinned.length
      ? pinned.map((ctx) => ctxItem(ctx, 'pin'))
      : [{ key: 'none', label: 'No pinned clusters', disabled: true }];
    list.push({ divider: true });

    const count = sorted.length ? String(sorted.length) : undefined;
    if (sorted.length && sorted.length <= MAX_INLINE) {
      list.push({ key: 'all-head', heading: true, label: 'All contexts', hint: count });
      sorted.forEach((ctx) => list.push(ctxItem(ctx, 'all')));
    } else if (sorted.length) {
      list.push({ key: 'all', label: 'All contexts', icon: 'cluster', hint: count, children: sorted.map((ctx) => ctxItem(ctx, 'all')) });
    }
    list.push({ key: 'search', label: 'Search contexts…', icon: 'search', onSelect: () => onOpenContexts?.() });
    list.push({ divider: true });

    if (currentContext) {
      list.push({ key: 'toggle-pin', label: `${isPinned ? 'Unpin' : 'Pin'} "${currentContext}"`, icon: 'pin', onSelect: () => onTogglePin?.(currentContext) });
    }
    const add = [];
    if (onAddAws) add.push({ key: 'aws', label: 'AWS EKS', icon: 'aws', onSelect: () => onAddAws() });
    if (onAddAzure) add.push({ key: 'azure', label: 'Azure AKS', icon: 'azure', onSelect: () => onAddAzure() });
    if (add.length) list.push({ key: 'add', label: 'Add cluster', icon: 'plus', children: add });
    return list;
  }, [pinned, sorted, providerOf, currentContext, isPinned, onSwitch, onTogglePin, onOpenContexts, onAddAws, onAddAzure]);

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!open) openMenu(); }
  };

  return (
    <div className="topbar-cluster">
      <Tooltip content="Switch cluster" placement="bottom">
        <button
          ref={btnRef}
          type="button"
          className="topbar-cluster-btn"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Switch cluster (current: ${currentContext || 'none'})`}
          onMouseDown={() => { wasOpenOnDown.current = open; }}
          onClick={() => {
            if (wasOpenOnDown.current) { wasOpenOnDown.current = false; return; }
            if (open) close(); else openMenu();
          }}
          onKeyDown={onKeyDown}
        >
          <Icon name={currentP.icon} size={15} className={`ctx-provider ctx-provider-${currentKey}`} />
          <span className="topbar-cluster-name">{currentContext || 'No cluster'}</span>
          <Icon name="chevronDown" size={12} strokeWidth={2.2} className="topbar-cluster-caret" />
        </button>
      </Tooltip>
      <Menu
        open={open}
        x={pos.x}
        y={pos.y}
        items={items}
        onClose={close}
        returnFocusTo={btnRef.current}
        ariaLabel="Switch cluster"
      />
    </div>
  );
}

export default React.memo(ClusterSwitcher);
