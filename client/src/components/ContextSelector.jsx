import { afterPaint } from '../lib/a11y';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Icon from './Icons';
import useClickOutside from '../hooks/useClickOutside';

// Provider → label/icon, shared with the top-bar ClusterSwitcher.
export const PROVIDERS = {
  aws: { label: 'AWS EKS', icon: 'aws' },
  azure: { label: 'Azure AKS', icon: 'azure' },
  gcp: { label: 'Google GKE', icon: 'cluster' },
  local: { label: 'Local', icon: 'box' },
  other: { label: 'Other clusters', icon: 'cluster' },
};
const ORDER = ['aws', 'azure', 'gcp', 'local', 'other'];
// Unknown provider tags (e.g. from an older or test-only server) fall into "Other clusters".
export const providerKeyOf = (provider) => (PROVIDERS[provider] ? provider : 'other');

// Dispatched by the top-bar cluster menu ("All contexts…") and by the desktop
// app's Clusters menu (via App) to pop this selector open.
export const OPEN_CONTEXTS_EVENT = 'kubepilot:open-contexts';

/**
 * Searchable context dropdown: trigger `aria-haspopup="listbox"`, labelled
 * search input, grouped `role="listbox"` with `role="option"` items.
 * Keyboard: ↑/↓ move, Enter picks, Escape closes, typing filters.
 */
export default function ContextSelector({ contexts = [], contextsInfo, currentContext, onChange, onAddAzure, onAddAws, onAddLocal, label = 'Kubernetes context' }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const ref = useRef(null);
  const searchRef = useRef(null);
  const triggerRef = useRef(null);

  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, close, open);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_CONTEXTS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_CONTEXTS_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (!open) { setQuery(''); setAddOpen(false); setActive(-1); return undefined; }
    const cancelRaf = afterPaint(() => searchRef.current?.focus());
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); triggerRef.current?.focus(); } };
    document.addEventListener('keydown', onKey);
    return () => { cancelRaf(); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const providerByName = useMemo(() => {
    const m = new Map();
    (contextsInfo || []).forEach((c) => m.set(c.name, c.provider));
    return m;
  }, [contextsInfo]);
  const providerOf = useCallback((name) => providerKeyOf(providerByName.get(name)), [providerByName]);
  const currentKey = providerOf(currentContext);
  const currentP = PROVIDERS[currentKey] || PROVIDERS.other;

  const q = query.toLowerCase();
  const visible = useMemo(() => contexts.filter((c) => !q || c.toLowerCase().includes(q)), [contexts, q]);
  const grouped = useMemo(() => {
    const g = {};
    visible.forEach((c) => { const pk = providerOf(c); (g[pk] = g[pk] || []).push(c); });
    Object.values(g).forEach((arr) => arr.sort((a, b) => a.localeCompare(b)));
    return g;
  }, [visible, providerOf]);
  const groupKeys = ORDER.filter((k) => grouped[k]?.length);
  // Flat option order (for keyboard navigation + activedescendant).
  const flat = useMemo(() => groupKeys.flatMap((k) => grouped[k]), [groupKeys, grouped]);
  useEffect(() => { setActive(flat.length ? 0 : -1); }, [flat]);

  const pick = (ctx) => { setOpen(false); triggerRef.current?.focus(); if (ctx !== currentContext) onChange(ctx); };
  const optId = useCallback((ctx) => `${id}-opt-${String(ctx).replace(/[^a-zA-Z0-9_-]/g, '_')}`, [id]);

  const onSearchKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(flat.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(flat.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (active >= 0 && flat[active]) pick(flat[active]); }
  };
  useEffect(() => {
    if (!open || active < 0 || !flat[active]) return;
    document.getElementById(optId(flat[active]))?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active, flat, optId]);

  const listId = `${id}-list`;
  return (
    <div className="ctx-select" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        className={`ctx-trigger ${open ? 'open' : ''}`}
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${label}: ${currentContext || 'none selected'}`}
        title={currentContext}
      >
        <Icon name={currentP.icon} size={15} className={`ctx-trigger-icon ctx-provider ctx-provider-${currentKey}`} />
        <span className="ctx-trigger-label">{currentContext || 'Select context'}</span>
        <span className="ctx-trigger-arrow" aria-hidden="true"><Icon name={open ? 'chevronUp' : 'chevronDown'} size={13} strokeWidth={2.2} /></span>
      </button>

      {open && (
        <div className="ctx-dropdown">
          <div className="ctx-search">
            <Icon name="search" size={14} />
            <label htmlFor={`${id}-search`} className="sr-only">Search contexts</label>
            <input
              ref={searchRef}
              id={`${id}-search`}
              type="text"
              placeholder={`Search ${contexts.length} contexts…`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKey}
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={active >= 0 && flat[active] ? optId(flat[active]) : undefined}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="ctx-list" id={listId} role="listbox" aria-label={label}>
            {visible.length === 0 && <div className="ctx-empty">No matches</div>}
            {groupKeys.map((k) => (
              <div key={k} className="ctx-group" role="group" aria-labelledby={`${id}-grp-${k}`}>
                <div className="ctx-group-head" id={`${id}-grp-${k}`}>
                  <Icon name={PROVIDERS[k].icon} size={13} className={`ctx-provider ctx-provider-${k}`} />
                  <span>{PROVIDERS[k].label}</span>
                  <span className="ctx-group-count">{grouped[k].length}</span>
                </div>
                {grouped[k].map((ctx) => {
                  const isCur = ctx === currentContext;
                  const isActive = flat[active] === ctx;
                  return (
                    <div
                      key={ctx}
                      id={optId(ctx)}
                      role="option"
                      aria-selected={isCur}
                      className={`ctx-option ${isCur ? 'active' : ''} ${isActive ? 'focused' : ''}`.replace(/\s+/g, ' ').trim()}
                      onMouseEnter={() => setActive(flat.indexOf(ctx))}
                      onClick={() => pick(ctx)}
                      title={ctx}
                    >
                      <span className="ctx-option-check" aria-hidden="true">{isCur && <Icon name="check" size={14} strokeWidth={2.4} />}</span>
                      <span className={`ctx-dot ctx-dot-${k}`} aria-hidden="true" />
                      <span className="ctx-option-label">{ctx}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          {(onAddAzure || onAddAws || onAddLocal) && (
            <div className="ctx-add-row">
              <button type="button" className={`ctx-add-cluster ${addOpen ? 'open' : ''}`} onClick={() => setAddOpen((o) => !o)} aria-expanded={addOpen}>
                <Icon name="plus" size={14} /> <span>Add cluster</span>
                <Icon name={addOpen ? 'chevronUp' : 'chevronDown'} size={12} className="ctx-add-caret" aria-hidden="true" />
              </button>
              {addOpen && (
                <div className="ctx-add-menu">
                  {onAddAws && (
                    <button type="button" className="ctx-add-item" onClick={() => { setOpen(false); onAddAws(); }}>
                      <Icon name="aws" size={15} className="ctx-provider ctx-provider-aws" /> AWS EKS
                    </button>
                  )}
                  {onAddAzure && (
                    <button type="button" className="ctx-add-item" onClick={() => { setOpen(false); onAddAzure(); }}>
                      <Icon name="azure" size={15} className="ctx-provider ctx-provider-azure" /> Azure AKS
                    </button>
                  )}
                  {onAddLocal && (
                    <button type="button" className="ctx-add-item" onClick={() => { setOpen(false); onAddLocal(); }}>
                      <Icon name="box" size={15} className="ctx-provider ctx-provider-local" /> Local — load kubeconfig
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
