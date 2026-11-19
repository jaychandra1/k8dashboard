import { afterPaint } from '../lib/a11y';
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import useClickOutside from '../hooks/useClickOutside';
import Icon from './Icons';
import { useNamespaceAccess, AddNamespaceForm, RESTRICTED_HINT } from './shell/NamespaceAccess';

const ALL = 'all';

/**
 * Multi-select namespace filter.
 *
 *   <NamespaceMultiSelect namespaces={['default','kube-system']} selected={['all']} onChange={(next) => …} />
 *
 * `selected` is either `['all']` (every namespace) or a list of names.
 * `namespaces` is the real list (an accidental 'all' entry is ignored).
 * Trigger: `<button aria-haspopup="listbox" aria-expanded>`; options are
 * `role="option" aria-selected` with checkbox visuals. Keyboard: ↑/↓/Home/End
 * move, Space/Enter toggle, Escape closes, typing jumps to a namespace.
 *
 * A user who may not list namespaces (shell/NamespaceAccess: `restricted`)
 * gets, under the list, a field to add theirs by name; "all" then means all
 * the namespaces they added.
 */
export default function NamespaceMultiSelect({ namespaces = [], selected = [ALL], onChange, label = 'Namespaces' }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const containerRef = useRef(null);
  const listRef = useRef(null);
  const triggerRef = useRef(null);
  const typeahead = useRef({ buf: '', t: null });
  const { restricted } = useNamespaceAccess();

  const realNamespaces = useMemo(() => namespaces.filter((ns) => ns && ns !== ALL), [namespaces]);
  const isAllSelected = selected.includes(ALL) || selected.length === 0;
  const options = useMemo(() => [ALL, ...realNamespaces], [realNamespaces]);

  const close = useCallback(() => setOpen(false), []);
  useClickOutside(containerRef, close, open);

  // With nothing to choose yet, a restricted user lands in the "add" field instead.
  const nothingYet = restricted && realNamespaces.length === 0;
  useEffect(() => {
    if (!open) return undefined;
    setActive(0);
    if (nothingYet) return undefined;
    const cancelRaf = afterPaint(() => {
      // Not when the user is already elsewhere in the picker (typing in the
      // "add" field): the list must not take the focus away from there.
      const at = document.activeElement;
      if (at && at !== triggerRef.current && containerRef.current?.contains(at)) return;
      listRef.current?.focus({ preventScroll: true });
    });
    return () => cancelRaf();
    // Only when it opens: adding the first namespace must not move the focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);

  const toggleAll = () => onChange([ALL]);

  const toggleNamespace = (ns) => {
    let next;
    if (isAllSelected) next = [ns];
    else if (selected.includes(ns)) next = selected.filter((n) => n !== ns);
    else next = [...selected, ns];
    if (next.length === 0 || next.length === realNamespaces.length) next = [ALL];
    onChange(next);
  };

  const toggleAt = (i) => { if (i === 0) toggleAll(); else if (options[i]) toggleNamespace(options[i]); };

  const removeTag = (ns) => {
    const next = selected.filter((n) => n !== ns);
    onChange(next.length === 0 ? [ALL] : next);
  };

  const allLabel = restricted ? 'All my namespaces' : 'All namespaces';
  const summaryLabel = () => {
    if (nothingYet) return 'Add a namespace';
    // One namespace is all there is: say its name.
    if (isAllSelected && restricted && realNamespaces.length === 1) return realNamespaces[0];
    if (isAllSelected) return allLabel;
    if (selected.length === 1) return selected[0];
    return `${selected.length} namespaces`;
  };

  const closeAndFocus = () => { setOpen(false); triggerRef.current?.focus(); };

  // The list takes the focus a moment after the picker opens (after the next
  // paint); until then, and after Shift+Tab back to the button, Escape arrives
  // here. It closes the picker from here too.
  const onTriggerKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); }
    else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
  };

  const onListKey = (e) => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActive((a) => Math.min(options.length - 1, a + 1)); break;
      case 'ArrowUp': e.preventDefault(); setActive((a) => Math.max(0, a - 1)); break;
      case 'Home': e.preventDefault(); setActive(0); break;
      case 'End': e.preventDefault(); setActive(options.length - 1); break;
      case ' ': case 'Enter': e.preventDefault(); toggleAt(active); break;
      case 'Escape': e.preventDefault(); e.stopPropagation(); closeAndFocus(); break;
      // Tab leaves the list: to the "add" field when there is one.
      case 'Tab': if (!restricted || e.shiftKey) setOpen(false); break;
      default: {
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const ta = typeahead.current;
          clearTimeout(ta.t);
          ta.buf += e.key.toLowerCase();
          ta.t = setTimeout(() => { ta.buf = ''; }, 500);
          const start = active + 1;
          const order = [...options.slice(start), ...options.slice(0, start)];
          const hit = order.find((o) => (o === ALL ? allLabel : o).toLowerCase().startsWith(ta.buf));
          if (hit) setActive(options.indexOf(hit));
        }
      }
    }
  };

  const listId = `${id}-list`;
  const optId = (i) => `${id}-opt-${i}`;
  const isChecked = (i) => (i === 0 ? isAllSelected : (isAllSelected || selected.includes(options[i])));

  return (
    <div className="namespace-multi-select" ref={containerRef}>
      {/* The box is clickable for the mouse; the arrow button is the keyboard /
          screen-reader trigger. Tag "remove" controls are real sibling buttons. */}
      <div
        className="namespace-multi-select-trigger"
        onClick={(e) => { if (!e.target.closest('button')) setOpen(!open); }}
      >
        {isAllSelected || selected.length > 2 ? (
          <span className="namespace-multi-select-label">{summaryLabel()}</span>
        ) : (
          <span className="namespace-tags">
            {selected.map((ns) => (
              <span key={ns} className="namespace-tag">
                {ns}
                <button type="button" className="namespace-tag-remove" onClick={() => removeTag(ns)} aria-label={`Remove ${ns} from the filter`}>
                  <span aria-hidden="true">×</span>
                </button>
              </span>
            ))}
          </span>
        )}
        <button
          ref={triggerRef}
          type="button"
          className="namespace-multi-select-arrow"
          onClick={() => setOpen(!open)}
          onKeyDown={onTriggerKey}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-label={`${label}: ${summaryLabel()}`}
        >
          <Icon name="chevronDown" size={14} className={`namespace-multi-select-chevron${open ? ' open' : ''}`} />
        </button>
      </div>

      {open && (
        <div className="namespace-multi-select-dropdown" data-restricted={restricted || undefined}>
        <div
          ref={listRef}
          id={listId}
          className="namespace-options"
          role="listbox"
          aria-multiselectable="true"
          aria-label={label}
          aria-activedescendant={optId(active)}
          tabIndex={-1}
          onKeyDown={onListKey}
        >
          {options.map((opt, i) => (
            <React.Fragment key={opt}>
              {i === 1 && <div className="namespace-option-divider" role="separator" />}
              <div
                id={optId(i)}
                data-idx={i}
                role="option"
                aria-selected={isChecked(i)}
                className={`namespace-option ${i === active ? 'focused' : ''}`.trim()}
                onMouseEnter={() => setActive(i)}
                onClick={() => toggleAt(i)}
              >
                <input type="checkbox" checked={isChecked(i)} readOnly tabIndex={-1} aria-hidden="true" />
                {i === 0 ? allLabel : opt}
              </div>
            </React.Fragment>
          ))}
        </div>
        {restricted && (
          <div
            className="namespace-add-panel"
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAndFocus(); } }}
          >
            <p className="namespace-add-hint">{RESTRICTED_HINT}</p>
            <AddNamespaceForm
              compact
              autoFocus={nothingYet}
              onAdded={(ns) => onChange(isAllSelected ? [ns] : Array.from(new Set([...selected, ns])))}
            />
          </div>
        )}
        </div>
      )}
    </div>
  );
}
