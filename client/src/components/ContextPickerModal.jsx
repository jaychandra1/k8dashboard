import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import Icon from './Icons';
import Modal from './ui/Modal';
import Button from './ui/Button';

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

// Dispatched to pop the searchable context picker open. App owns the picker
// and listens for this; the top-bar cluster menu ("Search contexts…"), the
// command palette and the desktop app's native Clusters menu all end up here.
export const OPEN_CONTEXTS_EVENT = 'kubepilot:open-contexts';
export function openContextPicker() {
  window.dispatchEvent(new CustomEvent(OPEN_CONTEXTS_EVENT));
}

/**
 * Searchable, provider-grouped context list: labelled search `combobox` +
 * grouped `role="listbox"` of `role="option"` rows. Keyboard: ↑/↓ move,
 * Home/End jump, Enter picks, typing filters. It does not manage focus or
 * Escape — the surrounding dialog does (Modal focus trap / Escape).
 *
 *   <ContextList contexts contextsInfo currentContext onPick(ctx) label />
 *
 * Used by ContextPickerModal and inline by AuthErrorModal.
 */
export function ContextList({ contexts = [], contextsInfo, currentContext, onPick, label = 'Kubernetes contexts', autoFocus = false }) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);

  const providerByName = useMemo(() => {
    const m = new Map();
    (contextsInfo || []).forEach((c) => m.set(c.name, c.provider));
    return m;
  }, [contextsInfo]);
  const providerOf = useCallback((name) => providerKeyOf(providerByName.get(name)), [providerByName]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => contexts.filter((c) => !q || c.toLowerCase().includes(q)), [contexts, q]);
  const grouped = useMemo(() => {
    const g = {};
    visible.forEach((c) => { const pk = providerOf(c); (g[pk] = g[pk] || []).push(c); });
    Object.values(g).forEach((arr) => arr.sort((a, b) => a.localeCompare(b)));
    return g;
  }, [visible, providerOf]);
  const groupKeys = ORDER.filter((k) => grouped[k]?.length);
  // Flat option order (keyboard navigation + aria-activedescendant).
  const flat = useMemo(() => groupKeys.flatMap((k) => grouped[k]), [groupKeys, grouped]);
  useEffect(() => {
    // Start on the current context when it is visible, else the first match.
    const cur = flat.indexOf(currentContext);
    setActive(flat.length ? (cur >= 0 && !q ? cur : 0) : -1);
  }, [flat, currentContext, q]);

  const optId = useCallback((ctx) => `${id}-opt-${String(ctx).replace(/[^a-zA-Z0-9_-]/g, '_')}`, [id]);
  const pick = (ctx) => onPick?.(ctx);

  const onSearchKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(flat.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(flat.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (active >= 0 && flat[active]) pick(flat[active]); }
  };
  useEffect(() => {
    if (active < 0 || !flat[active]) return;
    document.getElementById(optId(flat[active]))?.scrollIntoView?.({ block: 'nearest' });
  }, [active, flat, optId]);

  const listId = `${id}-list`;
  return (
    <div className="ctxp">
      <div className="dd-search">
        <Icon name="search" size={14} />
        <label htmlFor={`${id}-search`} className="sr-only">Search contexts</label>
        <input
          id={`${id}-search`}
          type="text"
          placeholder={`Search ${contexts.length} context${contexts.length === 1 ? '' : 's'}…`}
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
          autoFocus={autoFocus}
        />
      </div>
      <ul className="dd-list ctxp-list" id={listId} role="listbox" aria-label={label}>
        {visible.length === 0 && <li className="dd-empty" role="presentation">No matches</li>}
        {groupKeys.map((k) => (
          <li key={k} className="dd-group" role="group" aria-labelledby={`${id}-grp-${k}`}>
            <div className="dd-group-head" id={`${id}-grp-${k}`}>
              <Icon name={PROVIDERS[k].icon} size={13} className={`ctx-provider ctx-provider-${k}`} />
              <span>{PROVIDERS[k].label}</span>
              <span className="dd-group-count">{grouped[k].length}</span>
            </div>
            <ul role="presentation">
              {grouped[k].map((ctx) => {
                const isCur = ctx === currentContext;
                const isActive = flat[active] === ctx;
                return (
                  <li
                    key={ctx}
                    id={optId(ctx)}
                    role="option"
                    aria-selected={isCur}
                    className={`dd-option ${isCur ? 'active' : ''} ${isActive ? 'focused' : ''}`.replace(/\s+/g, ' ').trim()}
                    onMouseEnter={() => setActive(flat.indexOf(ctx))}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(ctx)}
                    title={ctx}
                  >
                    <span className="dd-option-check" aria-hidden="true">{isCur && <Icon name="check" size={14} strokeWidth={2.4} />}</span>
                    <span className={`ctx-dot ctx-dot-${k}`} aria-hidden="true" />
                    <span className="dd-option-label">{ctx}</span>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * "Search contexts…" dialog: every kubeconfig context, grouped by provider,
 * with a search box and keyboard navigation. Picking a context switches to it
 * and closes the dialog. Opened by App for the top-bar cluster menu, the
 * palette's "All contexts…" and the desktop Clusters menu (OPEN_CONTEXTS_EVENT).
 *
 *   <ContextPickerModal open onClose contexts contextsInfo currentContext onChange(ctx) onAddAws onAddAzure onAddLocal />
 */
export default function ContextPickerModal({ open, onClose, contexts = [], contextsInfo, currentContext, onChange, onAddAws, onAddAzure, onAddLocal }) {
  const pick = (ctx) => {
    onClose?.();
    if (ctx && ctx !== currentContext) onChange?.(ctx);
  };
  const run = (fn) => () => { onClose?.(); fn?.(); };
  const canAdd = !!(onAddAws || onAddAzure || onAddLocal);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Switch cluster"
      size="sm"
      className="ctx-picker"
      bodyClassName="ctx-picker-body"
      footer={canAdd ? (
        <div className="ctx-picker-footer">
          <span className="ctx-picker-add-label"><Icon name="plus" size={13} /> Add cluster</span>
          {onAddAws && <Button variant="ghost" size="sm" icon="aws" onClick={run(onAddAws)}>AWS EKS</Button>}
          {onAddAzure && <Button variant="ghost" size="sm" icon="azure" onClick={run(onAddAzure)}>Azure AKS</Button>}
          {onAddLocal && <Button variant="ghost" size="sm" icon="box" onClick={run(onAddLocal)}>Kubeconfig</Button>}
        </div>
      ) : undefined}
    >
      {open && (
        <ContextList
          contexts={contexts}
          contextsInfo={contextsInfo}
          currentContext={currentContext}
          onPick={pick}
          label="All contexts"
        />
      )}
    </Modal>
  );
}

export { ContextPickerModal };
