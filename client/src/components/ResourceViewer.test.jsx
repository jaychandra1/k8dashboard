import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ResourceViewer, { validateReplicas } from './ResourceViewer';
import { ToastProvider } from './Toast';

vi.mock('../lib/api', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    getJson: vi.fn(async () => ({ metrics: {} })),
    postJson: vi.fn(async () => ({ success: true })),
    del: vi.fn(async () => ({ success: true })),
  };
});
import { getJson, postJson, del } from '../lib/api';

const resources = [
  { name: 'beta', namespace: 'ns-a', status: 'Running', replicas: 2, createdAt: '2024-01-01T00:00:00Z' },
  { name: 'alpha', namespace: 'ns-b', status: 'Pending', replicas: 1, createdAt: '2024-01-02T00:00:00Z' },
  { name: 'gamma', namespace: 'ns-a', status: 'Running', replicas: 3, createdAt: '2024-01-03T00:00:00Z' },
];

function bodyRows() {
  const tbody = screen.getAllByRole('rowgroup')[1];
  return within(tbody).getAllByRole('row').filter((r) => !r.classList.contains('dt-spacer') && !r.classList.contains('dt-state-row'));
}
const rowNames = () => bodyRows().map((r) => within(r).getByText(/^(alpha|beta|gamma)$/).textContent);

function renderViewer(props = {}) {
  const onSelectResource = vi.fn();
  const utils = render(
    <ToastProvider>
      <ResourceViewer
        resourceType="deployment"
        resources={resources}
        namespaces={['all', 'ns-a', 'ns-b']}
        selectedNamespaces={['all']}
        onNamespaceChange={() => {}}
        onSelectResource={onSelectResource}
        onAction={() => {}}
        {...props}
      />
    </ToastProvider>,
  );
  return { ...utils, onSelectResource };
}

describe('ResourceViewer', () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

  it('renders a heading, the rows and a labelled search box', () => {
    renderViewer();
    expect(screen.getByRole('heading', { level: 1, name: /Deployments/ })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: /Deployments in all namespaces/ })).toBeInTheDocument();
    expect(rowNames()).toEqual(['alpha', 'beta', 'gamma']); // initial sort: name asc
    expect(screen.getByRole('searchbox', { name: 'Search Deployments' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actions for alpha' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Deployments/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('sorts by column header with aria-sort', async () => {
    const user = userEvent.setup();
    renderViewer();
    const nameBtn = screen.getByRole('button', { name: 'Name' });
    expect(nameBtn.closest('th')).toHaveAttribute('aria-sort', 'ascending');
    await user.click(nameBtn);
    expect(nameBtn.closest('th')).toHaveAttribute('aria-sort', 'descending');
    expect(rowNames()).toEqual(['gamma', 'beta', 'alpha']);
  });

  it('opens the drawer with Enter on a focused row', () => {
    const { onSelectResource } = renderViewer();
    const first = bodyRows()[0];
    first.focus();
    fireEvent.keyDown(first, { key: 'Enter' });
    expect(onSelectResource).toHaveBeenCalledWith(resources[1]); // alpha
  });

  it('filters rows by the search box', async () => {
    const user = userEvent.setup();
    renderViewer();
    await user.type(screen.getByRole('searchbox', { name: 'Search Deployments' }), 'gam');
    expect(rowNames()).toEqual(['gamma']);
  });

  it('bulk restart asks for a two-step confirmation before posting', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    renderViewer({ onAction });
    await user.click(screen.getByRole('checkbox', { name: 'Select alpha' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select beta' }));
    const bar = screen.getByRole('region', { name: 'Bulk actions' });
    expect(within(bar).getByText('2 selected')).toBeInTheDocument();
    await user.click(within(bar).getByRole('button', { name: /Restart/ }));

    let dlg = await screen.findByRole('dialog', { name: 'Restart 2 Deployments' });
    expect(postJson).not.toHaveBeenCalled();
    await user.click(within(dlg).getByRole('button', { name: 'Restart' }));
    dlg = await screen.findByRole('dialog', { name: 'Restart 2 Deployments' });
    expect(within(dlg).getByText(/Confirm the restart/)).toBeInTheDocument();
    expect(postJson).not.toHaveBeenCalled();
    await user.click(within(dlg).getByRole('button', { name: 'Yes, restart' }));

    await waitFor(() => expect(postJson).toHaveBeenCalledTimes(2));
    expect(postJson).toHaveBeenCalledWith('/api/restart/ns-b/deployment/alpha');
    expect(postJson).toHaveBeenCalledWith('/api/restart/ns-a/deployment/beta');
    await waitFor(() => expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ type: 'bulkRestart', ok: 2, failed: 0 })));
    expect(del).not.toHaveBeenCalled();
  });

  it('single delete is two-step and calls the delete endpoint', async () => {
    const user = userEvent.setup();
    renderViewer();
    await user.click(screen.getByRole('button', { name: 'Actions for gamma' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
    let dlg = await screen.findByRole('dialog', { name: 'Delete Deployment' });
    await user.click(within(dlg).getByRole('button', { name: 'Delete' }));
    dlg = await screen.findByRole('dialog', { name: 'Delete Deployment' });
    await user.click(within(dlg).getByRole('button', { name: 'Yes, delete' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/resource/ns-a/deployment/gamma'));
  });

  it('deployments: a Logs button beside each name opens the deployment\'s logs (not the drawer)', async () => {
    const user = userEvent.setup();
    getJson.mockImplementation(async (url) => {
      if (url === '/api/deployments/ns-b/alpha/pods') return { pods: [{ name: 'alpha-5d6e-q1', containerNames: ['app'], status: 'Running' }], total: 1 };
      if (url === '/api/logs/ns-b/alpha-5d6e-q1') return { logs: '2024-01-01T00:00:00.000Z alpha says hi' };
      return { metrics: {} };
    });
    const { onSelectResource } = renderViewer();
    const header = screen.getAllByRole('columnheader').map((th) => th.textContent);
    expect(header.indexOf('Logs')).toBe(header.findIndex((h) => /Name/.test(h)) + 1);
    await user.click(screen.getByRole('button', { name: 'Logs for alpha' }));
    expect(onSelectResource).not.toHaveBeenCalled();
    await screen.findByText(/alpha says hi/);
    expect(getJson).toHaveBeenCalledWith('/api/deployments/ns-b/alpha/pods', expect.anything());
    expect(screen.getByRole('tab', { name: /alpha/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('combobox', { name: 'Pod' })).toBeInTheDocument();
    // Also in the row menu.
    await user.click(screen.getByRole('button', { name: 'Actions for gamma' }));
    expect(await screen.findByRole('menuitem', { name: 'Logs' })).toBeInTheDocument();
  });

  it('deployments with no pods say so in the logs panel', async () => {
    const user = userEvent.setup();
    getJson.mockImplementation(async (url) => (url.startsWith('/api/deployments/') ? { pods: [], total: 0 } : { metrics: {} }));
    renderViewer();
    await user.click(screen.getByRole('button', { name: 'Logs for beta' }));
    expect(await screen.findByText(/No pods are running for/)).toHaveTextContent('No pods are running for beta');
  });

  it('pods: the Logs button opens that pod\'s logs', async () => {
    const user = userEvent.setup();
    getJson.mockImplementation(async (url) => (url === '/api/logs/ns-a/beta' ? { logs: '2024-01-01T00:00:00.000Z beta pod line' } : { metrics: {} }));
    renderViewer({ resourceType: 'pod', resources: resources.map((r) => ({ ...r, containerNames: ['app'] })) });
    await user.click(screen.getByRole('button', { name: 'Logs for beta' }));
    await screen.findByText(/beta pod line/);
    expect(getJson).toHaveBeenCalledWith('/api/logs/ns-a/beta', expect.objectContaining({ params: expect.objectContaining({ container: 'app' }) }));
    expect(screen.queryByRole('combobox', { name: 'Pod' })).toBeNull();
  });

  it('kinds without logs get no Logs column', () => {
    renderViewer({ resourceType: 'configMap', resources: [{ name: 'cm', namespace: 'ns-a', dataKeys: 1 }] });
    expect(screen.queryByRole('button', { name: /^Logs for/ })).toBeNull();
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).not.toContain('Logs');
  });

  it('validates the scale form', () => {
    expect(validateReplicas('')).toMatch(/Enter/);
    expect(validateReplicas('1.5')).toMatch(/whole number/);
    expect(validateReplicas('-1')).toMatch(/between 0 and 10000/);
    expect(validateReplicas('10001')).toMatch(/between 0 and 10000/);
    expect(validateReplicas('3')).toBeNull();
  });

  it('shows the empty state with a hint and the error state', () => {
    const { rerender } = renderViewer({ resources: [] });
    expect(screen.getByText('No deployments found')).toBeInTheDocument();
    expect(screen.getByText(/No deployments in all namespaces/)).toBeInTheDocument();
    rerender(
      <ToastProvider>
        <ResourceViewer resourceType="deployment" resources={[]} error={{ status: 502, code: 'upstream_error', message: 'boom' }} onAction={() => {}} />
      </ToastProvider>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/boom/);
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument();
  });
});
