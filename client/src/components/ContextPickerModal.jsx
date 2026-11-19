import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import Icon from './Icons';
import Tooltip from './ui/Tooltip';
import Modal from './ui/Modal';
import Button from './ui/Button';

// Provider → label/icon, shared with the top-bar ClusterSwitcher.
export const PROVIDERS = {
  aws: { label: 'AWS EKS', icon: 'aws' },
  azure: { label: 'Azure AKS', icon: 'azure' },
  gcp: { label: 'Google GKE', icon: 'hexagon' },
  local: { label: 'Local', icon: 'box' },
  other: { label: 'Other clusters', icon: 'cluster' },
};
const ORDER = ['aws', 'azure', 'gcp', 'local', 'other'];
// Unknown provider tags (e.g. from an older or test-only server) fall into "Other clusters".
export const providerKeyOf = (provider) => (PROVIDERS[provider] ? provider : 'other');

// Dispatched to open the "Switch cluster" window. App owns it and listens for
// this; the top-bar cluster button, the command palette and the desktop app's
// Clusters menu all end up here.
export const OPEN_CONTEXTS_EVENT = 'kubepilot:open-contexts';
export function openContextPicker() {
  window.dispatchEvent(new CustomEvent(OPEN_CONTEXTS_EVENT));
}

/**
 * Searchable, provider-grouped context list: labelled search `combobox` +
 * grouped `role="listbox"` of `role="option"` rows. Keyboard: ↑/↓ move,
 * Home/End jump, Enter picks, typing filters. It does not manage focus or
 * Escape — the surrounding dialog does (Modal focus trap / Escape).
 * With `onRemove`, each row gets a remove button, shown on hover and on the
 * keyboard-active row; Shift+Delete removes the active one. Both only ask:
 * the caller opens the confirmation (RemoveClusterDialog).
 *
 *   <ContextList contexts contextsInfo currentContext onPick(ctx) onRemove(ctx)? canRemove(ctx)? label />
 *
 * Used by ContextPickerModal.
 */
export function ContextList({ contexts = [], contextsInfo, currentContext, onPick, onRemove, canRemove, label = 'Clusters', autoFocus = false }) {
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
  // Memoised: a new array each render would make `flat` new each render, and
  // the effect below would put the highlight back on the current context
  // after every ↑/↓.
  const groupKeys = useMemo(() => ORDER.filter((k) => grouped[k]?.length), [grouped]);
  // Flat option order (keyboard navigation + aria-activedescendant).
  const flat = useMemo(() => groupKeys.flatMap((k) => grouped[k]), [groupKeys, grouped]);
  useEffect(() => {
    // Start on the current context when it is visible, else the first match.
    const cur = flat.indexOf(currentContext);
    setActive(flat.length ? (cur >= 0 && !q ? cur : 0) : -1);
  }, [flat, currentContext, q]);

  const optId = useCallback((ctx) => `${id}-opt-${String(ctx).replace(/[^a-zA-Z0-9_-]/g, '_')}`, [id]);
  const pick = (ctx) => onPick?.(ctx);
  const removable = (ctx) => !!onRemove && (!canRemove || canRemove(ctx));

  const onSearchKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(flat.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(flat.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (active >= 0 && flat[active]) pick(flat[active]); }
    else if (e.key === 'Delete' && e.shiftKey && active >= 0 && removable(flat[active])) { e.preventDefault(); onRemove(flat[active]); }
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
        <label htmlFor={`${id}-search`} className="sr-only">Search clusters</label>
        <input
          id={`${id}-search`}
          type="text"
          placeholder={`Search ${contexts.length} cluster${contexts.length === 1 ? '' : 's'}…`}
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
                    {removable(ctx) && (
                      <Tooltip content="Remove from kubeconfig… (Shift+Delete)" placement="left">
                        <button
                          type="button"
                          className="ctxp-remove"
                          tabIndex={-1}
                          aria-label={`Remove ${ctx}`}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={(e) => { e.stopPropagation(); onRemove(ctx); }}
                        >
                          <Icon name="delete" size={14} />
                        </button>
                      </Tooltip>
                    )}
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
 * The "Switch cluster" window — the one place to change cluster while
 * connected. Opened by the top-bar cluster button, the palette and the desktop
 * Clusters menu (OPEN_CONTEXTS_EVENT). Top to bottom:
 *
 *   search + every cluster, grouped by provider (✓ on the connected one;
 *     picking one connects to it; the bin on a row removes it from the kubeconfig)
 *   Add a cluster: AWS EKS · Azure AKS · Google GKE · Kubeconfig (one row)
 *   Disconnect (back to Home)
 *
 * It only ever asks: the caller connects, opens the add/remove dialogs and
 * comes back here when one of them is cancelled (App, "back to the picker").
 *
 *   <ContextPickerModal open onClose contexts contextsInfo currentContext onChange(ctx)
 *     onRemove(ctx)? canRemove(ctx)? onAddAws onAddAzure onAddGke onAddLocal onDisconnect />
 */
export default function ContextPickerModal({ open, onClose, contexts = [], contextsInfo, currentContext, onChange, onRemove, canRemove, onAddAws, onAddAzure, onAddGke, onAddLocal, onDisconnect }) {
  const pick = (ctx) => {
    onClose?.();
    if (ctx && ctx !== currentContext) onChange?.(ctx);
  };
  const addOptions = [
    onAddAws && { key: 'aws', label: 'AWS EKS', icon: 'aws', run: onAddAws },
    onAddAzure && { key: 'azure', label: 'Azure AKS', icon: 'azure', run: onAddAzure },
    onAddGke && { key: 'gcp', label: 'Google GKE', icon: 'hexagon', run: onAddGke },
    onAddLocal && { key: 'local', label: 'Kubeconfig', icon: 'box', run: onAddLocal },
  ].filter(Boolean);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Switch cluster"
      size="md"
      className="ctx-picker"
      bodyClassName="ctx-picker-body"
      footer={onDisconnect && currentContext ? (
        <div className="ctx-picker-footer">
          <span className="ctx-picker-current" title={currentContext}>Connected to <b>{currentContext}</b></span>
          <Button variant="secondary" size="sm" icon="close" onClick={() => onDisconnect()}>Disconnect</Button>
        </div>
      ) : undefined}
    >
      {open && (
        <>
          <ContextList
            contexts={contexts}
            contextsInfo={contextsInfo}
            currentContext={currentContext}
            onPick={pick}
            onRemove={onRemove}
            canRemove={canRemove}
            label="Clusters"
            autoFocus
          />
          {addOptions.length > 0 && (
            <section className="ctx-picker-add" aria-labelledby="ctx-picker-add-h">
              <h3 id="ctx-picker-add-h" className="ctx-picker-add-h">Add a cluster</h3>
              <div className="ctx-picker-add-row" style={{ gridTemplateColumns: `repeat(${addOptions.length}, minmax(0, 1fr))` }}>
                {addOptions.map((o) => (
                  <button key={o.key} type="button" className="ctx-picker-add-btn" onClick={() => o.run()}>
                    <Icon name={o.icon} size={16} className={`ctx-provider ctx-provider-${o.key}`} />
                    <span>{o.label}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </Modal>
  );
}

export { ContextPickerModal };
