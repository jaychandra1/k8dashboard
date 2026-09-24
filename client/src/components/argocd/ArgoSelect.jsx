import { afterPaint } from '../../lib/a11y';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Icon from '../Icons';

/**
 * Searchable single-select with listbox semantics (a native <select> is
 * unusable with hundreds of applications and closes on every re-render).
 *
 *   <ArgoSelect label="Application" value options=[{value,label}] onChange placeholder icon width />
 *
 * Trigger: aria-haspopup="listbox" aria-expanded aria-controls; ArrowDown/Enter/Space open.
 * Popup: search input (aria-controls the list, aria-activedescendant = active option),
 * <ul role="listbox"> of <li role="option" aria-selected>. Arrow keys move,
 * Home/End jump, typing filters (typeahead), Enter picks, Escape closes and
 * returns focus to the trigger. Document listeners exist only while open.
 */
export default function ArgoSelect({ label, value, options = [], placeholder = 'Select…', onChange, icon, width, disabled }) {
  const id = useId();
  const listId = `${id}-list`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const searchRef = useRef(null);
  const listRef = useRef(null);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => (q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options), [options, q]);
  const current = options.find((o) => o.value === value);
  const optionId = (i) => `${id}-opt-${i}`;

  // Stable: only touches state setters and refs.
  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    setQuery('');
    if (restoreFocus) triggerRef.current?.focus();
  }, []);
  const openList = () => {
    if (disabled) return;
    setOpen(true);
    const idx = Math.max(0, options.findIndex((o) => o.value === value));
    setActive(idx);
  };
  const pick = (o) => { close(); onChange?.(o.value); };

  // Outside-click listener only while the popup is open.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) close(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, close]);

  useEffect(() => { if (open) afterPaint(() => searchRef.current?.focus()); }, [open]);
  useEffect(() => { setActive((a) => Math.min(a, Math.max(0, filtered.length - 1))); }, [filtered.length]);
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);

  const onTriggerKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || ((e.key === 'Enter' || e.key === ' ') && !open)) { e.preventDefault(); openList(); }
  };
  const onPopupKey = (e) => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)); break;
      case 'ArrowUp': e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); break;
      case 'Home': e.preventDefault(); setActive(0); break;
      case 'End': e.preventDefault(); setActive(Math.max(0, filtered.length - 1)); break;
      case 'Enter': e.preventDefault(); if (filtered[active]) pick(filtered[active]); break;
      case 'Escape': e.preventDefault(); e.stopPropagation(); close(); break;
      case 'Tab': close(false); break;
      default: break;
    }
  };

  return (
    <div className="dd-select" ref={rootRef} style={{ width }}>
      <button
        ref={triggerRef}
        type="button"
        className={`dd-trigger ${open ? 'open' : ''}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={label ? `${label}: ${current?.label || placeholder}` : undefined}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onTriggerKey}
      >
        {icon && <Icon name={icon} size={15} className="dd-trigger-icon" />}
        <span className={`dd-trigger-label ${current ? '' : 'dd-trigger-placeholder'}`}>{current?.label || placeholder}</span>
        <span className="dd-trigger-arrow" aria-hidden="true"><Icon name={open ? 'chevronUp' : 'chevronDown'} size={13} strokeWidth={2.2} /></span>
      </button>
      {open && (
        <div className="dd-dropdown" onKeyDown={onPopupKey}>
          <div className="dd-search">
            <Icon name="search" size={14} />
            <input
              ref={searchRef}
              type="text"
              role="combobox"
              aria-label={label ? `Search ${label.toLowerCase()}` : 'Search options'}
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={filtered[active] ? optionId(active) : undefined}
              placeholder="Search…"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActive(0); }}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <ul ref={listRef} id={listId} role="listbox" aria-label={label} className="dd-list">
            {filtered.length === 0 && <li className="dd-empty" role="presentation">No matches</li>}
            {filtered.map((o, i) => {
              const selected = o.value === value;
              return (
                <li
                  key={o.value}
                  id={optionId(i)}
                  role="option"
                  aria-selected={selected}
                  data-idx={i}
                  className={`dd-option ${selected ? 'active' : ''} ${i === active ? 'focused' : ''}`}
                  title={o.label}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(o)}
                >
                  <span className="dd-option-check" aria-hidden="true">{selected && <Icon name="check" size={14} strokeWidth={2.4} />}</span>
                  <span className="dd-option-label">{o.label}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

export { ArgoSelect };
