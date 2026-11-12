import { describe, it, expect, vi } from 'vitest';
import {render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DataTable, { columnSizing } from './DataTable';

const rows = [
  { name: 'beta', namespace: 'a', status: 'Running', age: 30 },
  { name: 'alpha', namespace: 'b', status: 'Pending', age: 10 },
  { name: 'gamma', namespace: 'a', status: 'Failed', age: 20 },
];
const columns = [
  { key: 'name', header: 'Name', sortable: true, ellipsis: true },
  { key: 'status', header: 'Status', sortable: true },
  { key: 'age', header: 'Age', sortable: true, accessor: (r) => r.age, render: (r) => `${r.age}s`, align: 'right' },
];
const rowKey = (r) => `${r.namespace}/${r.name}`;

function bodyNames() {
  const tbody = screen.getAllByRole('rowgroup')[1];
  return within(tbody).getAllByRole('row').filter((r) => !r.classList.contains('dt-spacer')).map((r) => within(r).getAllByRole('cell')[0].textContent);
}

describe('DataTable', () => {
  it('renders table semantics with sortable header buttons', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={rowKey} caption="Pods" />);
    const table = screen.getByRole('table', { name: /Pods/ });
    expect(table).toHaveAttribute('aria-rowcount', '3');
    const headers = screen.getAllByRole('columnheader');
    expect(headers).toHaveLength(3);
    expect(headers[0]).toHaveAttribute('aria-sort', 'none');
    expect(within(headers[0]).getByRole('button', { name: 'Name' })).toBeInTheDocument();
    expect(bodyNames()).toEqual(['beta', 'alpha', 'gamma']);
    // ellipsis cells carry a title
    expect(screen.getByText('beta').closest('td')).toHaveAttribute('title', 'beta');
  });

  it('sorts asc → desc → none and persists to localStorage', async () => {
    const user = userEvent.setup();
    localStorage.clear();
    render(<DataTable columns={columns} rows={rows} rowKey={rowKey} storageKey="t" />);
    const btn = screen.getByRole('button', { name: 'Name' });
    await user.click(btn);
    expect(bodyNames()).toEqual(['alpha', 'beta', 'gamma']);
    expect(btn.closest('th')).toHaveAttribute('aria-sort', 'ascending');
    expect(JSON.parse(localStorage.getItem('dt:t:sort'))).toEqual({ key: 'name', dir: 'asc' });
    await user.click(btn);
    expect(bodyNames()).toEqual(['gamma', 'beta', 'alpha']);
    expect(btn.closest('th')).toHaveAttribute('aria-sort', 'descending');
    await user.click(btn);
    expect(bodyNames()).toEqual(['beta', 'alpha', 'gamma']);
    // numeric accessor sort
    await user.click(screen.getByRole('button', { name: 'Age' }));
    expect(bodyNames()).toEqual(['alpha', 'gamma', 'beta']);
  });

  it('supports roving focus + keyboard navigation and activation', async () => {
    const onRowActivate = vi.fn();
    render(<DataTable columns={columns} rows={rows} rowKey={rowKey} onRowActivate={onRowActivate} />);
    const tbody = screen.getAllByRole('rowgroup')[1];
    const trs = within(tbody).getAllByRole('row');
    expect(trs[0]).toHaveAttribute('tabindex', '0');
    expect(trs[1]).toHaveAttribute('tabindex', '-1');
    trs[0].focus();
    fireEvent.keyDown(trs[0], { key: 'ArrowDown' });
    await new Promise((r) => setTimeout(r, 20));
    expect(trs[1]).toHaveFocus();
    expect(trs[1]).toHaveAttribute('tabindex', '0');
    expect(trs[0]).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(trs[1], { key: 'End' });
    await new Promise((r) => setTimeout(r, 20));
    expect(trs[2]).toHaveFocus();
    fireEvent.keyDown(trs[2], { key: 'Home' });
    await new Promise((r) => setTimeout(r, 20));
    expect(trs[0]).toHaveFocus();
    fireEvent.keyDown(trs[0], { key: 'Enter' });
    expect(onRowActivate).toHaveBeenCalledWith(rows[0]);
    fireEvent.click(trs[1]);
    expect(onRowActivate).toHaveBeenCalledWith(rows[1]);
  });

  it('selection column with select all', async () => {
    const user = userEvent.setup();
    const onToggleAll = vi.fn();
    const onToggleSelect = vi.fn();
    const selected = new Set(['a/beta']);
    render(<DataTable columns={columns} rows={rows} rowKey={rowKey} selected={selected} onToggleSelect={onToggleSelect} onToggleAll={onToggleAll} />);
    const all = screen.getByRole('checkbox', { name: 'Select all rows' });
    expect(all).not.toBeChecked();
    expect(all.indeterminate).toBe(true);
    await user.click(all);
    expect(onToggleAll).toHaveBeenCalledWith(true, expect.any(Array));
    const beta = screen.getByRole('checkbox', { name: 'Select beta' });
    expect(beta).toBeChecked();
    expect(beta.closest('tr')).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('checkbox', { name: 'Select alpha' }));
    expect(onToggleSelect).toHaveBeenCalledWith(rows[1], 'b/alpha');
  });

  it('row actions button opens an accessible menu; Shift+F10 too', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<DataTable columns={columns} rows={rows} rowKey={rowKey} rowActions={(r) => [{ label: `Logs ${r.name}`, onSelect }, { label: 'Delete', danger: true, onSelect() {} }]} />);
    await user.click(screen.getByRole('button', { name: 'Actions for beta' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(2);
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
    const tbody = screen.getAllByRole('rowgroup')[1];
    const tr = within(tbody).getAllByRole('row')[1];
    tr.focus();
    fireEvent.keyDown(tr, { key: 'F10', shiftKey: true });
    expect(await screen.findByRole('menu', { name: 'Actions for alpha' })).toBeInTheDocument();
  });

  it('shows skeleton while loading and the empty state when empty', () => {
    const { rerender } = render(<DataTable columns={columns} rows={[]} rowKey={rowKey} loading />);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    rerender(<DataTable columns={columns} rows={[]} rowKey={rowKey} emptyState={<p>none</p>} />);
    expect(screen.getByText('none')).toBeInTheDocument();
  });

  it('virtualises large lists with spacer rows', () => {
    // jsdom has no layout: give the scroll container a 600px viewport. The
    // virtualiser reads clientHeight (virtual-core ≥ 3.19; offsetHeight before).
    const props = ['clientHeight', 'offsetHeight'];
    const saved = props.map((p) => [p, Object.getOwnPropertyDescriptor(HTMLElement.prototype, p)]);
    for (const p of props) Object.defineProperty(HTMLElement.prototype, p, { configurable: true, get: () => 600 });
    const many = Array.from({ length: 500 }, (_, i) => ({ name: `p${i}`, namespace: 'n', status: 'Running', age: i }));
    try {
      render(<DataTable columns={columns} rows={many} rowKey={rowKey} />);
    } finally {
      for (const [p, d] of saved) {
        if (d) Object.defineProperty(HTMLElement.prototype, p, d);
        else delete HTMLElement.prototype[p];
      }
    }
    const table = screen.getByRole('table');
    expect(table).toHaveAttribute('aria-rowcount', '500');
    const tbody = screen.getAllByRole('rowgroup')[1];
    const rendered = within(tbody).getAllByRole('row').filter((r) => !r.classList.contains('dt-spacer'));
    expect(rendered.length).toBeLessThan(500);
  });
});

// A virtualised table renders only the rows near the viewport, and a browser
// sizes columns by the cells it is given; fixedColumns takes the cells out of it.
describe('DataTable column widths', () => {
  const sized = [
    { key: 'name', header: 'Name', sortable: true, ellipsis: true, width: 300, maxWidth: 460 },
    { key: 'status', header: 'Status', sortable: true, width: 160, title: (r) => `status: ${r.status}` },
    { key: 'age', header: 'Age', sortable: true, accessor: (r) => r.age, render: (r) => `${r.age}s`, align: 'right', width: 80, fill: true },
  ];
  const actions = () => [{ label: 'Open', onSelect: () => {} }];

  it('by default a width is a hint: only ellipsis cells are capped (unchanged)', () => {
    expect(columnSizing(sized)).toEqual([
      { th: { width: 300, minWidth: undefined }, td: { maxWidth: 460 }, fixed: false },
      { th: { width: 160, minWidth: undefined }, td: undefined, fixed: false },
      { th: { width: '100%', minWidth: 80 }, td: undefined, fixed: false },
    ]);
  });

  it('fixedColumns: a sized column is exactly its width, one may stretch, the fill column takes the rest', () => {
    const [name, status, age] = columnSizing(sized, { fixed: true, selectable: true, actions: true });
    // Every other column (160 + 80), the checkbox (50) and actions (50) columns, and room for the scrollbar (18).
    const elastic = 'clamp(300px, calc(100cqw - 358px), 460px)';
    expect(name).toEqual({ th: { width: elastic, minWidth: elastic, maxWidth: elastic }, td: { maxWidth: elastic }, fixed: true });
    expect(status).toEqual({ th: { width: 160, minWidth: 160, maxWidth: 160 }, td: { maxWidth: 160 }, fixed: true });
    expect(age).toEqual({ th: { width: '100%', minWidth: 80 }, td: { maxWidth: 80 }, fixed: true });
    expect(columnSizing(sized, { fixed: true })[0].th.width).toBe('clamp(300px, calc(100cqw - 258px), 460px)');
  });

  it('fixedColumns: with `fit`, the column stretches only as far as its content needs', () => {
    const fitting = [{ ...sized[0], fit: () => 0 }, sized[1], sized[2]];
    const nameWidth = (fit) => columnSizing(fitting, { fixed: true, fit })[0].th.width;
    expect(nameWidth(0)).toBe(300);
    expect(nameWidth(280)).toBe(300);
    expect(nameWidth(379.2)).toBe('clamp(300px, calc(100cqw - 258px), 380px)');
    expect(nameWidth(900)).toBe('clamp(300px, calc(100cqw - 258px), 460px)');
    expect(columnSizing(fitting, { fixed: true, fit: 280 })[0]).toEqual({
      th: { width: 300, minWidth: 300, maxWidth: 300 },
      td: { maxWidth: 300 },
      fixed: true,
    });
  });

  it('fixedColumns: a column with no width stays content-sized, and then nothing stretches', () => {
    const [name, free] = columnSizing([sized[0], { key: 'note', header: 'Note' }, sized[2]], { fixed: true });
    expect(name).toEqual({ th: { width: 300, minWidth: 300, maxWidth: 300 }, td: { maxWidth: 300 }, fixed: true });
    expect(free).toEqual({ th: { minWidth: undefined }, td: undefined, fixed: false });
  });

  it('renders the same widths whatever the rows hold, however they are sorted', async () => {
    const user = userEvent.setup();
    const data = [
      { name: 'short', namespace: 'a', status: 'Running', age: 1 },
      { name: 'a-very-long-pod-name-that-would-widen-a-content-sized-column-0123456789', namespace: 'a', status: 'CreateContainerConfigError', age: 2 },
    ];
    const widths = () => screen.getAllByRole('columnheader').map((th) => [th.style.width, th.style.minWidth, th.style.maxWidth].join('/'));
    const table = (rowsShown) => (
      <DataTable columns={sized} rows={rowsShown} rowKey={rowKey} fixedColumns selected={new Set()} onToggleSelect={() => {}} rowActions={actions} />
    );
    const { container, rerender } = render(table(data));
    expect(container.querySelector('.dt-wrap')).toHaveAttribute('data-fixed', 'true');
    const before = widths();
    // checkbox, name (stretches: a CSS expression), status, age, actions
    expect(before[0]).toBe('50px/50px/50px');
    expect(before[2]).toBe('160px/160px/160px');
    expect(before[3]).toBe('100%/80px/');
    expect(before[4]).toBe('50px/50px/50px');
    const long = screen.getByRole('cell', { name: /^a-very-long-pod-name/ });
    expect(long).toHaveClass('dt-fixed');
    expect(long).toHaveAttribute('title', data[1].name);
    // What is cut short is in the tooltip: here the column's own title().
    const status = screen.getByRole('cell', { name: 'CreateContainerConfigError' });
    expect(status).toHaveClass('dt-fixed');
    expect(status.style.maxWidth).toBe('160px');
    expect(status).toHaveAttribute('title', 'status: CreateContainerConfigError');
    await user.click(screen.getByRole('button', { name: /Status/ }));
    expect(widths()).toEqual(before);
    rerender(table([data[0]]));
    expect(widths()).toEqual(before);
  });

  it('without fixedColumns nothing is pinned', () => {
    const { container } = render(<DataTable columns={sized} rows={rows} rowKey={rowKey} />);
    expect(container.querySelector('.dt-wrap')).not.toHaveAttribute('data-fixed');
    expect(container.querySelector('.dt-fixed')).toBeNull();
    const status = screen.getAllByRole('columnheader')[1];
    expect([status.style.width, status.style.minWidth, status.style.maxWidth]).toEqual(['160px', '', '']);
  });
});
