import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ArgoCD from './ArgoCD';
import { getJson } from '../../lib/api';

vi.mock('../../lib/api', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, getJson: vi.fn(), postJson: vi.fn(), del: vi.fn() };
});
vi.mock('../Toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

const apps = [
  { name: 'web', namespace: 'argocd', project: 'default', syncStatus: 'Synced', healthStatus: 'Healthy', destNamespace: 'prod', repoURL: 'https://git.example.com/web.git', revision: 'abc1234', createdAt: '2024-01-01T00:00:00Z' },
  { name: 'api', namespace: 'argocd', project: 'default', syncStatus: 'OutOfSync', healthStatus: 'Degraded', destNamespace: 'prod', repoURL: 'https://git.example.com/api.git', revision: 'def5678', createdAt: '2024-01-02T00:00:00Z' },
];

beforeEach(() => {
  getJson.mockImplementation(async (url) => {
    if (url.endsWith('/applications')) return { applications: apps };
    if (url.endsWith('/projects')) return { projects: [] };
    if (url.endsWith('/applicationsets')) return { available: true, applicationSets: [] };
    if (url.endsWith('/repositories')) return { repositories: [] };
    if (url.endsWith('/clusters')) return { clusters: [] };
    if (url.endsWith('/status')) return { installed: true, url: '' };
    return {};
  });
});

describe('ArgoCD applications table', () => {
  it('renders one row per application with tone badges and a labelled checkbox', async () => {
    render(<ArgoCD view="applications" />);
    const table = await screen.findByRole('table', { name: /Argo CD applications/ });
    const tbody = within(table).getAllByRole('rowgroup')[1];
    const rows = within(tbody).getAllByRole('row').filter((r) => !r.classList.contains('dt-spacer'));
    expect(rows).toHaveLength(2);
    expect(within(table).getByText('OutOfSync').closest('.ui-badge')).toHaveAttribute('data-tone', 'warn');
    expect(within(table).getByText('Degraded').closest('.ui-badge')).toHaveAttribute('data-tone', 'bad');
    expect(screen.getByRole('checkbox', { name: 'Select web' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Argo CD' })).toBeInTheDocument();
  });

  it('toggles a row selection from the keyboard and shows the bulk bar', async () => {
    const user = userEvent.setup();
    render(<ArgoCD view="applications" />);
    const box = await screen.findByRole('checkbox', { name: 'Select web' });
    box.focus();
    await user.keyboard(' ');
    expect(box).toBeChecked();
    expect(box.closest('tr')).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('1 selected')).toBeInTheDocument();
    await user.keyboard(' ');
    expect(box).not.toBeChecked();
    await waitFor(() => expect(screen.queryByText('1 selected')).toBeNull());
  });

  it('opens the sync ConfirmModal from the row actions menu', async () => {
    const user = userEvent.setup();
    render(<ArgoCD view="applications" />);
    await user.click(await screen.findByRole('button', { name: 'Actions for api' }));
    const menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: 'Sync…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sync api' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('button', { name: 'Synchronize' })).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: /Prune/ })).not.toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
