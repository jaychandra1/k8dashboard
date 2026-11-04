// The Events page's filters: server-side (namespace, workload, Warnings,
// search), a removable workload chip, "x of y" counts and "Load more".
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../lib/api', async (orig) => {
  const actual = await orig();
  return { ...actual, getJson: vi.fn() };
});
import { getJson } from '../lib/api';
import Events from './Events';

const ev = (i, type = 'Warning') => ({ message: `event ${i}`, namespace: 'shop', type, reason: 'BackOff', involvedObject: `Pod/web-${i}`, count: 1, age: 60 * i, lastTimestamp: `2026-11-04T10:${String(59 - (i % 60)).padStart(2, '0')}:00Z` });
const RESOURCES = { deployments: [{ name: 'web' }, { name: 'api' }], statefulSets: [{ name: 'db' }], daemonSets: [], cronJobs: [], jobs: [] };

function mockApi({ total = 2, unfiltered = 10 } = {}) {
  getJson.mockImplementation(async (url, { params = {} } = {}) => {
    if (url.startsWith('/api/resources/')) return RESOURCES;
    const page = params.page || 1;
    const from = (page - 1) * 100;
    const events = Array.from({ length: Math.max(0, Math.min(100, total - from)) }, (_, i) => ev(from + i));
    return { events, pagination: { page, limit: 100, total, pages: Math.ceil(total / 100) }, unfiltered, ...(params.workload ? { workload: params.workload } : {}) };
  });
}

describe('Events filters', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('sends the filters to the server and shows "x of y"; Warnings / search / workload go through onFiltersChange', async () => {
    mockApi();
    const onFiltersChange = vi.fn();
    const user = userEvent.setup();
    render(<Events namespace="shop" selectedNamespaces={['shop']} namespaces={['shop', 'ops']} onNamespaceChange={() => {}}
      type="Warning" search="" workload="Deployment/web" onFiltersChange={onFiltersChange} />);
    await screen.findByText('event 0');
    expect(getJson).toHaveBeenCalledWith('/api/events/shop', expect.objectContaining({ params: expect.objectContaining({ type: 'Warning', workload: 'Deployment/web', page: 1, limit: 100 }) }));
    expect(screen.getByText('2 of 10 events')).toBeInTheDocument();
    // The workload chip says what's included, and removes the filter.
    expect(screen.getByText(/its ReplicaSets and Pods/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove the Deployment web filter' }));
    expect(onFiltersChange).toHaveBeenLastCalledWith({ workload: undefined });
    await user.click(screen.getByRole('button', { name: 'All' }));
    expect(onFiltersChange).toHaveBeenLastCalledWith({ type: undefined });
    // The workload picker lists the namespace's workloads by kind.
    const select = await screen.findByRole('combobox');
    await waitFor(() => expect(select.querySelectorAll('option').length).toBeGreaterThan(2));
    await user.selectOptions(select, 'StatefulSet/db');
    expect(onFiltersChange).toHaveBeenLastCalledWith({ workload: 'StatefulSet/db' });
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onFiltersChange).toHaveBeenLastCalledWith({ type: undefined, q: undefined, workload: undefined });
  });

  it('a workload filter needs one namespace; with "all" the picker is disabled and no workload is sent', async () => {
    mockApi();
    render(<Events namespace="all" workload="Deployment/web" onFiltersChange={() => {}} />);
    await screen.findByText('event 0');
    expect(screen.getByRole('combobox')).toBeDisabled();
    expect(getJson).toHaveBeenCalledWith('/api/events/all', expect.objectContaining({ params: expect.objectContaining({ workload: undefined }) }));
  });

  it('"Load more" fetches the next page and appends it', async () => {
    mockApi({ total: 150, unfiltered: 150 });
    const user = userEvent.setup();
    render(<Events namespace="shop" />);
    await screen.findByText('Showing 100 of 150');
    await user.click(screen.getByRole('button', { name: 'Load 50 more' }));
    // Pages 1 and 2 (150 rows: the table virtualizes past 100, so check the requests and the counter).
    await waitFor(() => expect(getJson).toHaveBeenCalledWith('/api/events/shop', expect.objectContaining({ params: expect.objectContaining({ page: 2 }) })));
    await waitFor(() => expect(screen.queryByText(/Showing/)).toBeNull());
    expect(screen.getByText('150 events')).toBeInTheDocument();
  });

  it('local filters when uncontrolled (the workloads view tab): Warnings refetches with type=Warning', async () => {
    mockApi();
    const user = userEvent.setup();
    render(<Events namespace="shop" />);
    await screen.findByText('event 0');
    await user.click(screen.getByRole('button', { name: /Warnings/ }));
    await waitFor(() => expect(getJson).toHaveBeenLastCalledWith('/api/events/shop', expect.objectContaining({ params: expect.objectContaining({ type: 'Warning' }) })));
  });
});
