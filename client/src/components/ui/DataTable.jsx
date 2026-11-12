import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import Icon from '../Icons';
import Button from './Button';
import Menu from './Menu';
import Skeleton from './Skeleton';
import EmptyState from './EmptyState';
import {announce, afterPaint } from '../../lib/a11y';

/**
 * Accessible, optionally virtualised data table with real <table> semantics.
 *
 * <DataTable
 *   columns={[
 *     { key: 'name', header: 'Name', sortable: true, render: (r) => <NameCell … /> , ellipsis: true, width: 260 },
 *     { key: 'status', header: 'Status', sortable: true, accessor: (r) => r.status, render: (r) => <Badge status={r.status} /> },
 *     { key: 'age', header: 'Age', sortable: true, accessor: (r) => new Date(r.createdAt).getTime(), render: (r) => formatAge(r.createdAt), align: 'right' },
 *   ]}
 *   rows={pods} rowKey={(r) => `${r.namespace}/${r.name}`} rowName={(r) => r.name}
 *   onRowActivate={(r) => select(r)} onRowContextMenu={(r, { x, y }) => …} rowActions={(r) => menuItems}
 *   selected={selectedSet} onToggleSelect={(r) => …} onToggleAll={(checked) => …}
 *   activeKey={selected?.name} getRowTone={(r) => 'bad'}
 *   caption="Pods in kube-system" emptyState={<EmptyState … />} loading refetching
 *   initialSort={{ key: 'name', dir: 'asc' }} storageKey="pods"
 * />
 *
 * Column widths. By default a column's `width` is a hint and the browser sizes
 * columns by the cells it is given. A virtualised table renders only the rows
 * near the viewport, so those widths change as rows scroll or sort into view:
 * one long status just below the fold widens "Status" for every row above it.
 * With `fixedColumns`, a column that names a `width` is exactly that wide
 * whatever its cells hold (what doesn't fit is cut with an ellipsis and shown
 * in the cell's tooltip), so the layout is the same for every row, sort order
 * and scroll position:
 *   { width: 160 }                  exactly 160px
 *   { width: 300, maxWidth: 460 }   300px, growing to 460px while the table has spare room
 *                                   (the first such column, when every column has a width).
 *                                   With `fit: (rows) => px` it grows only as far as its
 *                                   content needs: the widest it has needed in this table,
 *                                   so short names leave no gap and a filter doesn't move it.
 *   { width: 80, fill: true }       at least 80px, plus whatever room is left
 * A column without a `width` is still sized by its content.
 */
const SORT_ICON = { asc: 'chevronUp', desc: 'chevronDown' };
// The checkbox and row-actions columns, in px (fixedColumns pins them too).
const SELECT_COL = 50;
const ACTIONS_COL = 50;
// Room kept for the vertical scrollbar when a column stretches: the scroll
// area's width (100cqw) counts the scrollbar, the table inside can't use it.
const SCROLLBAR = 18;
const pinned = (size) => ({ width: size, minWidth: size, maxWidth: size });

/**
 * How each column is sized: [{ th, td, fixed }] — the header cell's style, the
 * body cells' style, and whether the column is independent of its content.
 * (Table cells honour min-width / max-width, and a cell's max-width caps what
 * its content may ask for: that is what pins a column in a content-sized table.)
 */
export function columnSizing(columns, { fixed = false, selectable = false, actions = false, fit = 0 } = {}) {
  if (!fixed) {
    return columns.map((col) => ({
      // `fill`: this column takes the spare width (the others keep theirs).
      th: { width: col.fill ? '100%' : col.width, minWidth: col.fill ? col.width : col.minWidth },
      td: col.ellipsis ? { maxWidth: col.maxWidth || col.width || 280 } : undefined,
      fixed: false,
    }));
  }
  const sized = (col) => Number.isFinite(col.width);
  // One column may stretch into spare room: only when every other width is
  // known, so the room left for it can be worked out without measuring.
  const elastic = columns.every(sized)
    ? columns.find((c) => !c.fill && Number.isFinite(c.maxWidth) && c.maxWidth > c.width)
    : null;
  // How far it may stretch: to its maxWidth, or (col.fit) only as far as its content needs.
  const upTo = !elastic
    ? 0
    : typeof elastic.fit === 'function'
      ? Math.min(elastic.maxWidth, Math.ceil(fit) || 0)
      : elastic.maxWidth;
  const others = columns.reduce(
    (sum, c) => sum + (c === elastic ? 0 : c.width || 0),
    (selectable ? SELECT_COL : 0) + (actions ? ACTIONS_COL : 0) + SCROLLBAR
  );
  return columns.map((col) => {
    if (!sized(col))
      return { th: { minWidth: col.minWidth }, td: col.ellipsis ? { maxWidth: col.maxWidth || 280 } : undefined, fixed: false };
    if (col.fill) return { th: { width: '100%', minWidth: col.width }, td: { maxWidth: col.width }, fixed: true };
    // 100cqw: the width of the table's scroll area (.dt-wrap[data-fixed] is a size container).
    const size =
      col === elastic && upTo > col.width ? `clamp(${col.width}px, calc(100cqw - ${others}px), ${upTo}px)` : col.width;
    return { th: pinned(size), td: { maxWidth: size }, fixed: true };
  });
}

function defaultCompare(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return (a === b ? 0 : a ? -1 : 1);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function readSort(storageKey, initialSort) {
  if (!storageKey) return initialSort || null;
  try {
    const raw = localStorage.getItem(`dt:${storageKey}:sort`);
    if (raw) { const v = JSON.parse(raw); if (v && v.key) return v; }
  } catch { /* ignore */ }
  return initialSort || null;
}

export default function DataTable({
  columns = [],
  rows = [],
  rowKey,
  rowName,
  onRowActivate,
  onRowContextMenu,
  rowActions,
  selected,
  onToggleSelect,
  onToggleAll,
  getRowTone,
  activeKey,
  caption = 'Data table',
  emptyState,
  loading = false,
  refetching = false,
  virtualize,
  rowHeight = 42,
  stickyHeader = true,
  initialSort,
  storageKey,
  className = '',
  dense = false,
  overscan = 8,
  maxHeight,
  fixedColumns = false,
}) {
  const scrollRef = useRef(null);
  const rowEls = useRef(new Map());
  const [sort, setSort] = useState(() => readSort(storageKey, initialSort));
  const [focusIdx, setFocusIdx] = useState(0);
  const [menu, setMenu] = useState(null); // { row, x, y, returnFocusTo }
  const keyOf = useCallback((row, i) => (rowKey ? rowKey(row, i) : (row?.id ?? row?.uid ?? `${row?.namespace ?? ''}/${row?.name ?? i}`)), [rowKey]);
  const nameOf = useCallback((row) => (rowName ? rowName(row) : (row?.name ?? row?.id ?? 'row')), [rowName]);

  // ---- sorting ----
  useEffect(() => {
    if (!storageKey) return;
    try { if (sort) localStorage.setItem(`dt:${storageKey}:sort`, JSON.stringify(sort)); else localStorage.removeItem(`dt:${storageKey}:sort`); } catch { /* ignore */ }
  }, [sort, storageKey]);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const acc = col.accessor || ((r) => r?.[col.key]);
    const cmp = col.compare || defaultCompare;
    const dir = sort.dir === 'desc' ? -1 : 1;
    return rows.map((r, i) => ({ r, i, v: acc(r) }))
      .sort((a, b) => cmp(a.v, b.v) * dir || a.i - b.i)
      .map((x) => x.r);
  }, [rows, sort, columns]);

  const toggleSort = (col) => {
    if (!col.sortable) return;
    setSort((s) => {
      const next = s?.key === col.key ? (s.dir === 'asc' ? { key: col.key, dir: 'desc' } : null) : { key: col.key, dir: 'asc' };
      announce(next ? `Sorted by ${typeof col.header === 'string' ? col.header : col.key}, ${next.dir === 'asc' ? 'ascending' : 'descending'}` : 'Sorting cleared');
      return next;
    });
  };

  // ---- virtualisation ----
  const shouldVirtualize = virtualize ?? sorted.length > 100;
  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan,
    enabled: shouldVirtualize,
    // Render a sensible first window before the scroll element is measured.
    initialRect: { width: 0, height: 600 },
  });
  const vItems = shouldVirtualize ? virtualizer.getVirtualItems() : null;
  const paddingTop = vItems && vItems.length ? vItems[0].start : 0;
  const paddingBottom = vItems && vItems.length ? virtualizer.getTotalSize() - vItems[vItems.length - 1].end : 0;
  const visible = vItems ? vItems.map((v) => ({ row: sorted[v.index], index: v.index })) : sorted.map((row, index) => ({ row, index }));

  // ---- keyboard / roving focus ----
  useEffect(() => { if (focusIdx >= sorted.length) setFocusIdx(Math.max(0, sorted.length - 1)); }, [sorted.length, focusIdx]);

  const focusRow = useCallback((idx) => {
    const clamped = Math.max(0, Math.min(idx, sorted.length - 1));
    setFocusIdx(clamped);
    if (shouldVirtualize) virtualizer.scrollToIndex(clamped, { align: 'auto' });
    afterPaint(() => {
      const el = rowEls.current.get(clamped);
      if (el) { el.focus({ preventScroll: !shouldVirtualize ? false : true }); if (!shouldVirtualize) el.scrollIntoView?.({ block: 'nearest' }); }
    });
  }, [sorted.length, shouldVirtualize, virtualizer]);

  const openActions = useCallback((row, at, returnFocusTo) => {
    if (!rowActions) return;
    const items = rowActions(row);
    if (!items || !items.length) return;
    setMenu({ row, x: at.x, y: at.y, returnFocusTo });
  }, [rowActions]);

  const onRowKeyDown = (e, row, idx) => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); focusRow(idx + 1); break;
      case 'ArrowUp': e.preventDefault(); focusRow(idx - 1); break;
      case 'Home': e.preventDefault(); focusRow(0); break;
      case 'End': e.preventDefault(); focusRow(sorted.length - 1); break;
      case 'PageDown': e.preventDefault(); focusRow(idx + 10); break;
      case 'PageUp': e.preventDefault(); focusRow(idx - 10); break;
      case 'Enter': case ' ':
        if (e.target === e.currentTarget) { e.preventDefault(); onRowActivate?.(row); }
        break;
      case 'ContextMenu': case 'F10':
        if (e.key === 'F10' && !e.shiftKey) break;
        e.preventDefault();
        {
          const r = e.currentTarget.getBoundingClientRect();
          const at = { x: r.left + Math.min(r.width - 12, 220), y: r.top + r.height / 2 };
          if (onRowContextMenu) onRowContextMenu(row, at); else openActions(row, at, e.currentTarget);
        }
        break;
      default: break;
    }
  };

  const onContext = (e, row) => {
    if (!onRowContextMenu && !rowActions) return;
    e.preventDefault();
    const at = { x: e.clientX, y: e.clientY };
    if (onRowContextMenu) onRowContextMenu(row, at); else openActions(row, at, e.currentTarget);
  };

  // ---- selection ----
  const selectable = !!(selected && onToggleSelect);
  const allSelected = selectable && sorted.length > 0 && sorted.every((r, i) => selected.has(keyOf(r, i)));
  const someSelected = selectable && !allSelected && sorted.some((r, i) => selected.has(keyOf(r, i)));
  const selectAllRef = useRef(null);
  useEffect(() => { if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected; }, [someSelected]);

  const colCount = columns.length + (selectable ? 1 : 0) + (rowActions ? 1 : 0);
  // A stretching column's content (col.fit): the most room it has needed in this
  // table. It only ever grows, so narrowing the list with a filter moves nothing.
  const fitCol = fixedColumns ? columns.find((c) => typeof c.fit === 'function') : null;
  const fitNow = useMemo(() => (fitCol ? Math.ceil(fitCol.fit(rows)) || 0 : 0), [fitCol, rows]);
  const [fitMark, setFitMark] = useState({ key: storageKey, px: 0 });
  if (fitMark.key !== storageKey) setFitMark({ key: storageKey, px: fitNow });
  else if (fitNow > fitMark.px) setFitMark({ key: storageKey, px: fitNow });
  const fit = fitMark.key === storageKey ? Math.max(fitMark.px, fitNow) : fitNow;
  const sizing = useMemo(
    () => columnSizing(columns, { fixed: fixedColumns, selectable, actions: !!rowActions, fit }),
    [columns, fixedColumns, selectable, rowActions, fit]
  );
  const selectStyle = fixedColumns ? pinned(SELECT_COL) : undefined;
  const actionsStyle = fixedColumns ? pinned(ACTIONS_COL) : undefined;
  const showSkeleton = loading && rows.length === 0;
  const showEmpty = !loading && rows.length === 0;

  return (
    <div
      ref={scrollRef}
      className={`dt-wrap resource-table-wrap ${className}`.trim()}
      data-refetching={refetching || undefined}
      data-dense={dense || undefined}
      data-fixed={fixedColumns || undefined}
      style={maxHeight ? { maxHeight } : undefined}
      aria-busy={loading || refetching || undefined}
    >
      <table
        className="dt resource-table"
        aria-rowcount={sorted.length}
        aria-colcount={colCount}
        data-sticky={stickyHeader || undefined}
      >
        <caption className="sr-only">{caption}{sort ? `, sorted by ${sort.key} ${sort.dir === 'asc' ? 'ascending' : 'descending'}` : ''}</caption>
        <thead>
          <tr>
            {selectable && (
              <th scope="col" className="ck-col dt-ck" style={selectStyle}>
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  className="ck"
                  aria-label="Select all rows"
                  checked={allSelected}
                  onChange={(e) => onToggleAll?.(e.target.checked, sorted)}
                  disabled={sorted.length === 0}
                />
              </th>
            )}
            {columns.map((col, ci) => {
              const active = sort?.key === col.key;
              const ariaSort = col.ariaSort || (active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : (col.sortable ? 'none' : undefined));
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={ariaSort}
                  style={{ ...sizing[ci].th, textAlign: col.align }}
                  className={`dt-th${col.align ? ` dt-align-${col.align}` : ''}${col.className ? ` ${col.className}` : ''}`}
                >
                  {col.sortable ? (
                    <button type="button" className="dt-sort-btn" onClick={() => toggleSort(col)} data-active={active || undefined}>
                      <span>{col.header}</span>
                      <span className="dt-sort-icon" aria-hidden="true">
                        <Icon name={active ? SORT_ICON[sort.dir] : 'chevronDown'} size={12} strokeWidth={2.4} />
                      </span>
                    </button>
                  ) : col.header}
                </th>
              );
            })}
            {rowActions && <th scope="col" className="dt-actions-col" style={actionsStyle}><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody>
          {showSkeleton && (
            <tr className="dt-state-row"><td colSpan={colCount}><Skeleton rows={8} cols={Math.min(columns.length, 6)} /></td></tr>
          )}
          {showEmpty && (
            <tr className="dt-state-row"><td colSpan={colCount}>{emptyState || <EmptyState icon="box" title="Nothing here" />}</td></tr>
          )}
          {paddingTop > 0 && <tr aria-hidden="true" className="dt-spacer"><td colSpan={colCount} style={{ height: paddingTop, padding: 0, border: 0 }} /></tr>}
          {visible.map(({ row, index }) => {
            const key = keyOf(row, index);
            const isSelected = selectable && selected.has(key);
            const isActive = activeKey != null && activeKey === key;
            const tone = getRowTone?.(row);
            const name = nameOf(row);
            return (
              <tr
                key={key}
                ref={(el) => { if (el) rowEls.current.set(index, el); else rowEls.current.delete(index); }}
                className={`dt-row resource-table-row${isActive ? ' active' : ''}${isSelected ? ' selected' : ''}`}
                tabIndex={index === focusIdx ? 0 : -1}
                aria-rowindex={index + 1}
                aria-selected={selectable ? isSelected : (isActive || undefined)}
                data-tone={tone}
                data-index={index}
                style={shouldVirtualize ? { height: rowHeight } : undefined}
                onFocus={() => { if (focusIdx !== index) setFocusIdx(index); }}
                onKeyDown={(e) => onRowKeyDown(e, row, index)}
                onClick={(e) => { if (e.target.closest('button, a, input, [data-no-activate]')) return; onRowActivate?.(row); }}
                onContextMenu={(e) => onContext(e, row)}
              >
                {selectable && (
                  <td className="ck-col dt-ck" style={selectStyle}>
                    <input
                      type="checkbox"
                      className="ck"
                      aria-label={`Select ${name}`}
                      checked={isSelected}
                      onChange={() => onToggleSelect(row, key)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </td>
                )}
                {columns.map((col, ci) => {
                  const content = col.render ? col.render(row, index) : (col.accessor ? col.accessor(row) : row?.[col.key]);
                  const text = typeof content === 'string' || typeof content === 'number' ? String(content) : undefined;
                  // A cell that can be cut short says what it holds in its tooltip.
                  const clips = col.ellipsis || sizing[ci].fixed;
                  return (
                    <td
                      key={col.key}
                      className={`dt-td${col.ellipsis ? ' dt-ellipsis' : ''}${sizing[ci].fixed ? ' dt-fixed' : ''}${col.align ? ` dt-align-${col.align}` : ''}${col.mono ? ' dt-mono' : ''}${col.className ? ` ${col.className}` : ''}`}
                      style={sizing[ci].td}
                      title={clips ? (col.title ? col.title(row) : text) : undefined}
                    >
                      {content ?? '—'}
                    </td>
                  );
                })}
                {rowActions && (
                  <td className="dt-actions" style={actionsStyle}>
                    <Button
                      variant="ghost" size="sm" iconOnly icon="more"
                      ariaLabel={`Actions for ${name}`}
                      aria-haspopup="menu"
                      aria-expanded={menu?.row === row || undefined}
                      onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); openActions(row, { x: r.right - 4, y: r.bottom + 4 }, e.currentTarget); }}
                    />
                  </td>
                )}
              </tr>
            );
          })}
          {paddingBottom > 0 && <tr aria-hidden="true" className="dt-spacer"><td colSpan={colCount} style={{ height: paddingBottom, padding: 0, border: 0 }} /></tr>}
        </tbody>
      </table>
      {menu && rowActions && (
        <Menu
          open
          x={menu.x}
          y={menu.y}
          items={rowActions(menu.row)}
          returnFocusTo={menu.returnFocusTo}
          ariaLabel={`Actions for ${nameOf(menu.row)}`}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

export { DataTable };
