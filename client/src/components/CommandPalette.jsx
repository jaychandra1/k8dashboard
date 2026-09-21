import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icons';
import useFocusTrap from '../hooks/useFocusTrap';
import { announce } from '../lib/a11y';
import { NAV_GROUPS, typesInGroup } from '../lib/kinds';

// Spotlight-style command palette (⌘K). Navigate to any view, switch context,
// or run a quick action — keyboard-first. ARIA combobox + listbox inside a
// modal dialog (focus trap, Escape from anywhere, backdrop click).

export default function CommandPalette({ open, onClose, onNavigate, contexts = [], currentContext, onSwitchContext, onOpenPreferences, onRefresh, onSetTheme, argocdInstalled = false }) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const panelRef = useRef(null);
  useFocusTrap(panelRef, !!open, { initialFocusRef: inputRef });

  // Build the full command set (nav destinations + contexts + actions) from the registry.
  const commands = useMemo(() => {
    const cmds = [];
    for (const g of NAV_GROUPS) {
      for (const t of typesInGroup(g.key)) cmds.push({ id: `nav:${t.key}`, group: g.label, label: t.label, icon: t.icon, run: () => onNavigate(t.key) });
    }
    for (const t of typesInGroup('app')) {
      if (t.key === 'argocd' && !argocdInstalled) continue;
      cmds.push({ id: `nav:${t.key}`, group: 'Apps', label: t.label, icon: t.icon, run: () => onNavigate(t.key) });
    }
    for (const ctx of contexts) cmds.push({ id: `ctx:${ctx}`, group: 'Switch context', label: ctx, icon: 'cluster', hint: ctx === currentContext ? 'current' : '', run: () => onSwitchContext(ctx) });
    cmds.push(
      { id: 'act:refresh', group: 'Actions', label: 'Refresh', icon: 'refresh', run: () => onRefresh?.() },
      { id: 'act:prefs', group: 'Actions', label: 'Open Preferences', icon: 'settings', run: () => onOpenPreferences?.() },
      { id: 'act:theme-dark', group: 'Actions', label: 'Theme: Dark', icon: 'moon', run: () => onSetTheme?.('dark') },
      { id: 'act:theme-light', group: 'Actions', label: 'Theme: Light', icon: 'sun', run: () => onSetTheme?.('light') },
      { id: 'act:theme-system', group: 'Actions', label: 'Theme: System', icon: 'settings', run: () => onSetTheme?.('system') },
    );
    return cmds;
  }, [contexts, currentContext, argocdInstalled, onNavigate, onSwitchContext, onOpenPreferences, onRefresh, onSetTheme]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => (`${c.label} ${c.group}`).toLowerCase().includes(q));
  }, [query, commands]);

  // Reset on open.
  useEffect(() => { if (open) { setQuery(''); setSel(0); } }, [open]);
  useEffect(() => { setSel(0); }, [query]);
  // Announce the result count as the user types.
  useEffect(() => {
    if (!open) return;
    announce(filtered.length === 0 ? 'No matches' : `${filtered.length} result${filtered.length === 1 ? '' : 's'}`);
  }, [open, filtered.length]);
  // Keep the selected row in view.
  useEffect(() => { listRef.current?.querySelector('.cmdk-item.sel')?.scrollIntoView({ block: 'nearest' }); }, [sel]);
  // Escape from anywhere while open.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const exec = useCallback((c) => { if (!c) return; onClose(); c.run(); }, [onClose]);
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(filtered.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setSel(0); }
    else if (e.key === 'End') { e.preventDefault(); setSel(Math.max(0, filtered.length - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); exec(filtered[sel]); }
  };

  if (!open || typeof document === 'undefined') return null;
  const root = document.getElementById('modal-root') || document.body;
  const listId = `${id}-list`;
  const optId = (i) => `${id}-opt-${i}`;
  const labelId = `${id}-label`;

  // Render with group headers.
  let lastGroup = null;
  return createPortal(
    <div className="cmdk-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={panelRef} className="cmdk-panel" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="cmdk-input-row">
          <Icon name="search" size={16} />
          <label id={labelId} htmlFor={`${id}-input`} className="sr-only">Search views, contexts and actions</label>
          <input
            ref={inputRef}
            id={`${id}-input`}
            className="cmdk-input"
            placeholder="Search views, contexts, actions…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={filtered.length ? optId(sel) : undefined}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="cmdk-kbd" aria-hidden="true">esc</kbd>
        </div>
        <div className="cmdk-list" ref={listRef} id={listId} role="listbox" aria-labelledby={labelId}>
          {filtered.length === 0 && <div className="cmdk-empty">No matches</div>}
          {filtered.map((c, i) => {
            const header = c.group !== lastGroup ? (lastGroup = c.group) : null;
            return (
              <React.Fragment key={c.id}>
                {header && <div className="cmdk-group" role="presentation">{header}</div>}
                <div
                  id={optId(i)}
                  role="option"
                  aria-selected={i === sel}
                  className={`cmdk-item${i === sel ? ' sel' : ''}`}
                  onMouseEnter={() => setSel(i)}
                  onMouseDown={(e) => { e.preventDefault(); exec(c); }}
                >
                  <Icon name={c.icon} size={15} />
                  <span className="cmdk-label">{c.label}</span>
                  {c.hint && <span className="cmdk-hint">{c.hint}</span>}
                </div>
              </React.Fragment>
            );
          })}
        </div>
        <div className="cmdk-foot" aria-hidden="true">
          <span><kbd className="cmdk-kbd">↑</kbd><kbd className="cmdk-kbd">↓</kbd> navigate</span>
          <span><kbd className="cmdk-kbd">↵</kbd> open</span>
        </div>
      </div>
    </div>,
    root,
  );
}
