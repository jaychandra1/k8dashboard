import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Home, { orderClusters, clusterBadges } from './Home';
import LoadingScreen from './shell/LoadingScreen';
import { CONNECT_STEPS } from './shell/useContexts';

const SLOW = { timeout: 5000 };
const contexts = ['dev-env-cluster', 'pixdora-tech', 'tr-prod-cashierbackend', 'kind-local'];
const contextsInfo = [
  { name: 'dev-env-cluster', provider: 'aws', signIn: { kind: 'aws', state: 'signed-in', production: false } },
  { name: 'pixdora-tech', provider: 'aws', signIn: { kind: 'aws', state: 'expired', production: false } },
  { name: 'tr-prod-cashierbackend', provider: 'aws', signIn: { kind: 'aws', state: 'signed-out', production: true } },
  { name: 'kind-local', provider: 'local' },
];
const recent = [{ name: 'dev-env-cluster', at: Date.now() - 2 * 3600e3 }, { name: 'tr-prod-cashierbackend', at: Date.now() - 26 * 3600e3 }];

const setup = (props = {}) => {
  const h = { onConnect: vi.fn(), onTogglePin: vi.fn(), onRemove: vi.fn(), onAddAws: vi.fn(), onAddAzure: vi.fn(), onAddLocal: vi.fn(), onOpenPreferences: vi.fn(), onOpenDashboard: vi.fn(), onDisconnect: vi.fn() };
  render(<Home contexts={contexts} contextsInfo={contextsInfo} lastConnected="dev-env-cluster" recent={recent} pins={['tr-prod-cashierbackend']} {...h} {...props} />);
  return { ...h, user: userEvent.setup() };
};

describe('Home', () => {
  it('welcomes, offers the last connected cluster first, and lists every cluster (pinned, recent, then by name)', async () => {
    const { user, onConnect } = setup();
    expect(screen.getByRole('heading', { name: 'Welcome to K8Board' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
    const last = screen.getByRole('region', { name: 'Last connected' });
    expect(last).toHaveTextContent('dev-env-cluster');
    expect(last).toHaveTextContent('AWS EKS · last used 2h ago');
    const rows = within(screen.getByRole('list', { name: 'Clusters in your kubeconfig' })).getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('.home-row-name').textContent)).toEqual(['tr-prod-cashierbackend', 'dev-env-cluster', 'kind-local', 'pixdora-tech']);
    await user.click(within(last).getByRole('button', { name: 'Connect to dev-env-cluster' }));
    expect(onConnect).toHaveBeenCalledWith('dev-env-cluster');
  });

  it('badges from local information: production, signed out, session expired', () => {
    setup();
    const list = screen.getByRole('list', { name: 'Clusters in your kubeconfig' });
    const row = (name) => within(list).getByText(name).closest('li');
    expect(row('tr-prod-cashierbackend')).toHaveTextContent('Production');
    expect(row('tr-prod-cashierbackend')).toHaveTextContent('Signed out of AWS');
    expect(row('pixdora-tech')).toHaveTextContent('AWS session expired');
    expect(row('dev-env-cluster')).not.toHaveTextContent(/expired|Signed out/);
    expect(row('kind-local')).toHaveTextContent('Local');
  });

  it('search, pin and remove', async () => {
    const { user, onTogglePin, onRemove } = setup();
    await user.type(screen.getByRole('searchbox', { name: 'Search clusters' }), 'pix');
    const list = screen.getByRole('list', { name: 'Clusters in your kubeconfig' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    await user.click(within(list).getByRole('button', { name: 'Pin pixdora-tech' }));
    expect(onTogglePin).toHaveBeenCalledWith('pixdora-tech');
    await user.click(within(list).getByRole('button', { name: 'Remove pixdora-tech' }));
    expect(onRemove).toHaveBeenCalledWith('pixdora-tech');
    await user.clear(screen.getByRole('searchbox', { name: 'Search clusters' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search clusters' }), 'zzz');
    expect(screen.getByText('No cluster matches “zzz”.')).toBeInTheDocument();
  });

  it('Add cluster: AWS EKS, Azure AKS or a kubeconfig file', async () => {
    const { user, onAddLocal } = setup();
    await user.click(screen.getByRole('button', { name: 'Add cluster' }));
    const menu = await screen.findByRole('menu', { name: 'Add cluster' }, SLOW);
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['AWS EKS', 'Azure AKS', 'Kubeconfig file…']);
    await user.click(within(menu).getByRole('menuitem', { name: 'Kubeconfig file…' }));
    expect(onAddLocal).toHaveBeenCalled();
  });

  it('no clusters: says so and offers the ways to add one', async () => {
    const { user, onAddAws } = setup({ contexts: [], contextsInfo: [], lastConnected: null, recent: [] });
    expect(screen.getByRole('heading', { name: 'No clusters yet' })).toBeInTheDocument();
    await user.click(within(screen.getByRole('region', { name: 'No clusters' })).getByRole('button', { name: 'AWS EKS' }));
    expect(onAddAws).toHaveBeenCalled();
  });

  it('while connected: the connected cluster opens, the others connect, Disconnect leaves', async () => {
    const { user, onOpenDashboard, onDisconnect } = setup({ connected: 'dev-env-cluster' });
    expect(screen.queryByRole('region', { name: 'Last connected' })).toBeNull();
    const list = screen.getByRole('list', { name: 'Clusters in your kubeconfig' });
    expect(within(list).getByText('dev-env-cluster').closest('li')).toHaveTextContent('Connected');
    await user.click(within(list).getByRole('button', { name: 'Open dev-env-cluster' }));
    expect(onOpenDashboard).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(onDisconnect).toHaveBeenCalled();
  });

  it('pure helpers', () => {
    expect(orderClusters(['b', 'a', 'c'], { pins: ['c'], recent: [{ name: 'b', at: 1 }] })).toEqual(['c', 'b', 'a']);
    expect(orderClusters(['b', 'a'], { q: 'A' })).toEqual(['a']);
    expect(clusterBadges(undefined)).toEqual([]);
    expect(clusterBadges({ signIn: { state: 'renewable', production: false } })).toEqual([]);
  });
});

describe('LoadingScreen: connecting', () => {
  it('lists the steps with the current one marked, and Cancel', async () => {
    const onCancel = vi.fn();
    render(<LoadingScreen label="Connecting to dev…" steps={CONNECT_STEPS} step="auth" onCancel={onCancel} />);
    const steps = screen.getByRole('list', { name: 'Connection steps' });
    const items = within(steps).getAllByRole('listitem');
    expect(items.map((i) => i.dataset.state)).toEqual(['done', 'current', 'pending']);
    expect(items[1]).toHaveAttribute('aria-current', 'step');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
