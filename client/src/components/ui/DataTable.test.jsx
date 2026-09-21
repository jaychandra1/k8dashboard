import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DataTable from './DataTable';

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
    // jsdom has no layout; the virtualiser measures the scroll container via offsetHeight.
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 });
    const many = Array.from({ length: 500 }, (_, i) => ({ name: `p${i}`, namespace: 'n', status: 'Running', age: i }));
    render(<DataTable columns={columns} rows={many} rowKey={rowKey} />);
    if (desc) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', desc);
    const table = screen.getByRole('table');
    expect(table).toHaveAttribute('aria-rowcount', '500');
    const tbody = screen.getAllByRole('rowgroup')[1];
    const rendered = within(tbody).getAllByRole('row').filter((r) => !r.classList.contains('dt-spacer'));
    expect(rendered.length).toBeLessThan(500);
  });
});
