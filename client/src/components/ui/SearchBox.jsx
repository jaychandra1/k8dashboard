import { forwardRef, useId, useImperativeHandle, useRef } from 'react';
import Icon from '../Icons';

/**
 * Labelled search input with a clear button.
 * <SearchBox value onChange ariaLabel="Search pods" placeholder shortcut="/" onClear width />
 */
const SearchBox = forwardRef(function SearchBox({
  value = '',
  onChange,
  ariaLabel,
  placeholder = 'Search…',
  shortcut,
  onClear,
  autoFocus,
  className = '',
  style,
  inputProps = {},
}, ref) {
  const inputRef = useRef(null);
  useImperativeHandle(ref, () => inputRef.current);
  const id = useId();
  if (!ariaLabel && import.meta.env?.DEV) console.warn('<SearchBox> requires ariaLabel');
  const clear = () => {
    onChange?.('');
    onClear?.();
    inputRef.current?.focus();
  };
  return (
    <div className={`ui-search ${className}`.trim()} style={style} role="search">
      <label htmlFor={id} className="sr-only">{ariaLabel}</label>
      <span className="ui-search-icon" aria-hidden="true"><Icon name="search" size={14} /></span>
      <input
        ref={inputRef}
        id={id}
        type="search"
        className="ui-search-input"
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        onChange={(e) => onChange?.(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape' && value) { e.stopPropagation(); clear(); } inputProps.onKeyDown?.(e); }}
        {...inputProps}
      />
      {value ? (
        <button type="button" className="ui-search-clear" onClick={clear} aria-label="Clear search">
          <Icon name="close" size={12} />
        </button>
      ) : (shortcut ? <kbd className="ui-search-kbd" aria-hidden="true">{shortcut}</kbd> : null)}
    </div>
  );
});

export default SearchBox;
export { SearchBox };
