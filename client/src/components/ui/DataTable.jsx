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
 */
const SORT_ICON = { asc: 'chevronUp', desc: 'chevronDown' };

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
  const showSkeleton = loading && rows.length === 0;
  const showEmpty = !loading && rows.length === 0;

  return (
    <div
      ref={scrollRef}
      className={`dt-wrap resource-table-wrap ${className}`.trim()}
      data-refetching={refetching || undefined}
      data-dense={dense || undefined}
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
              <th scope="col" className="ck-col dt-ck">
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
            {columns.map((col) => {
              const active = sort?.key === col.key;
              const ariaSort = col.ariaSort || (active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : (col.sortable ? 'none' : undefined));
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={ariaSort}
                  style={{ width: col.width, minWidth: col.minWidth, textAlign: col.align }}
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
            {rowActions && <th scope="col" className="dt-actions-col"><span className="sr-only">Actions</span></th>}
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
                  <td className="ck-col dt-ck">
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
                {columns.map((col) => {
                  const content = col.render ? col.render(row, index) : (col.accessor ? col.accessor(row) : row?.[col.key]);
                  const text = typeof content === 'string' || typeof content === 'number' ? String(content) : undefined;
                  return (
                    <td
                      key={col.key}
                      className={`dt-td${col.ellipsis ? ' dt-ellipsis' : ''}${col.align ? ` dt-align-${col.align}` : ''}${col.mono ? ' dt-mono' : ''}${col.className ? ` ${col.className}` : ''}`}
                      style={col.ellipsis ? { maxWidth: col.maxWidth || col.width || 280 } : undefined}
                      title={col.ellipsis ? (col.title ? col.title(row) : text) : undefined}
                    >
                      {content ?? '—'}
                    </td>
                  );
                })}
                {rowActions && (
                  <td className="dt-actions">
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
