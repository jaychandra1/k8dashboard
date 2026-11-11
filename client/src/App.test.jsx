import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { _resetHistoryIndex } from './hooks/useHashRoute';

// ---- mocks ---------------------------------------------------------------
const responses = {
  '/api/config/status': { loaded: true, contexts: ['test-cluster', 'other-cluster'], contextsInfo: [{ name: 'test-cluster', provider: 'local' }, { name: 'other-cluster', provider: 'aws' }], currentContext: 'test-cluster' },
  '/api/config/auth': { ok: true, currentContext: 'test-cluster' },
  '/api/namespaces': { namespaces: ['default', 'kube-system'] },
  '/api/argocd/status': { installed: false },
  '/api/settings/pins': { pins: ['test-cluster'] },
  '/api/resources/default': { pods: [{ name: 'web-1', namespace: 'default', status: 'Running' }], deployments: [] },
  '/api/resources/kube-system': { pods: [{ name: 'coredns', namespace: 'kube-system', status: 'Running' }], deployments: [], partial: true, errors: [{ kind: 'secrets', error: 'forbidden' }] },
};

vi.mock('./lib/api', async (orig) => {
  const real = await orig();
  return {
    ...real,
    getToken: () => 'test-token',
    bootstrapTokenFromHash: () => false,
    getJson: vi.fn(async (url) => {
      const key = url.split('?')[0];
      if (key in responses) return JSON.parse(JSON.stringify(responses[key]));
      throw new real.ApiError({ status: 404, code: 'not_found', message: `no mock for ${url}`, url });
    }),
    postJson: vi.fn(async () => ({})),
  };
});

// Heavy views are owned by other engineers; stub them so App renders without their deps.
vi.mock('./components/ResourceViewer', () => ({ default: (p) => <div data-testid="rv" data-type={p.resourceType} data-selected={p.selectedResource?.name || ''} data-count={p.resources.length}><h1>{p.resourceType}</h1></div>, TAB_KEYS: [] }));
vi.mock('./components/Cluster', () => ({ default: ({ onOpen }) => <><h1>Cluster</h1><button type="button" onClick={() => onOpen?.('deployment')}>Open deployments</button></> }));
vi.mock('./components/Nodes', () => ({ default: (p) => <h1>Nodes {p.focusNode || ''}</h1> }));
vi.mock('./components/Namespaces', () => ({ default: () => <h1>Namespaces</h1> }));
vi.mock('./components/Topology', () => ({ default: () => <h1>Topology</h1> }));
vi.mock('./components/Helm', () => ({ default: () => <h1>Helm</h1> }));
vi.mock('./components/CustomResourceDetail', () => ({ default: (p) => <h1>CR {p.selection ? `${p.selection.plural}/${p.selection.name || ''}` : 'none'}</h1> }));
vi.mock('./components/CustomResourceTree', () => ({ default: () => null }));
vi.mock('./components/AccessControl', () => ({ default: () => <h1>Access</h1> }));
vi.mock('./components/SecurityCenter', () => ({ default: (p) => <h1>Security {p.view}</h1> }));
vi.mock('./components/ArgoCD', () => ({ default: (p) => <h1>Argo {p.view}</h1> }));
vi.mock('./components/Events', () => ({ default: (p) => <h1>Events {p.namespace}</h1> }));
vi.mock('./components/AgentPanel', () => ({ default: () => null }));
vi.mock('./components/Assistant', () => ({ default: () => null }));

import App from './App';
import { ToastProvider } from './components/Toast';

const renderApp = () => render(<ToastProvider><App /></ToastProvider>);
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
// The app opens on Home; a connection starts only from a Connect button.
const CLUSTER_CALLS = ['/api/config/auth', '/api/namespaces', '/api/argocd/status', '/api/resources', '/api/cluster'];
const clusterCalls = async () => {
  const { getJson } = await import('./lib/api');
  return getJson.mock.calls.map(([u]) => u.split('?')[0]).filter((u) => CLUSTER_CALLS.some((c) => u.startsWith(c)));
};
const connectFromHome = async (name = 'test-cluster') => {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Connect to ' + name }, { timeout: 5000 }));
  await waitFor(() => expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument());
  return user;
};
const go = (hash) => act(async () => { window.location.hash = hash; await new Promise((r) => setTimeout(r, 20)); });

describe('App routing', () => {
  beforeEach(async () => {
    _resetHistoryIndex(); window.location.hash = ''; localStorage.clear();
    const { getJson } = await import('./lib/api');
    getJson.mockClear();
  });

  it('opens on Home without contacting any cluster; Connect opens the Dashboard; hash navigation', async () => {
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Welcome to K8Board' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Clusters in your kubeconfig' })).toHaveTextContent('test-cluster');
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
    await settle();
    expect(await clusterCalls()).toEqual([]); // no sign-in, no API call, no resources
    expect(document.title).toMatch(/^Home — K8Board$/);

    await connectFromHome('test-cluster');
    expect(await clusterCalls()).toContain('/api/config/auth');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
    expect(screen.getByRole('banner')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Cluster' })).toBeInTheDocument());
    expect(document.title).toMatch(/^Cluster · test-cluster — K8Board$/);
    // The cluster switcher and, right beside it, the Back/Forward arrows open the
    // top bar (its `lead` slot); the sidebar holds neither.
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const header = screen.getByRole('banner');
    const switcher = screen.getByRole('button', { name: /Switch cluster/ });
    expect(switcher).toHaveTextContent('test-cluster');
    const lead = header.querySelector('.topbar-lead');
    expect(lead).not.toBeNull();
    const backBtn = screen.getByRole('button', { name: 'Back' });
    const fwdBtn = screen.getByRole('button', { name: 'Forward' });
    expect(lead.contains(switcher) && lead.contains(backBtn) && lead.contains(fwdBtn)).toBe(true);
    // Order: switcher first, then the history group.
    expect(lead.firstElementChild).toBe(switcher.closest('.cluster-switcher'));
    expect(lead.lastElementChild).toHaveClass('topbar-hist');
    expect(nav.contains(switcher) || nav.contains(backBtn) || nav.contains(fwdBtn)).toBe(false);
    expect(header.querySelector('.topbar-crumb')).toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: 'Pods' }));
    expect(window.location.hash).toBe('#/pod');
    await waitFor(() => expect(screen.getByTestId('rv')).toHaveAttribute('data-type', 'pod'));
    expect(screen.getByRole('link', { name: 'Pods' })).toHaveAttribute('aria-current', 'page');
    expect(document.title).toMatch(/^Pods · all namespaces · test-cluster — K8Board$/);

    // Back arrow in the top bar → previous view (the Dashboard the connection landed on).
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Cluster' })).toBeInTheDocument());
    expect(window.location.hash).toBe('#/cluster');
    expect(screen.getByRole('button', { name: 'Forward' })).toBeEnabled();
  }, 15000);

  it('Disconnect (cluster switcher) goes back to Home', async () => {
    renderApp();
    const user = await connectFromHome();
    await user.click(screen.getByRole('button', { name: /Switch cluster/ }));
    await user.click(within(await screen.findByRole('menu', { name: 'Switch cluster' })).getByRole('menuitem', { name: 'Disconnect' }));
    expect(await screen.findByRole('heading', { name: 'Welcome to K8Board' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/home');
    const { postJson } = await import('./lib/api');
    expect(postJson).toHaveBeenCalledWith('/api/config/disconnect');
  }, 15000);

  it('a deep link opens Home first; old #/overview links go to the Dashboard; its lists open on all namespaces', async () => {
    window.location.hash = '#/overview?ns=default';
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Welcome to K8Board' }, { timeout: 5000 })).toBeInTheDocument();
    await waitFor(() => expect(window.location.hash).toBe('#/home'));
    await connectFromHome();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Cluster' })).toBeInTheDocument());
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).queryByRole('link', { name: 'Overview' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open deployments' }));
    await waitFor(() => expect(window.location.hash).toBe('#/deployment')); // all namespaces = no ns filter
  });

  it('switching cluster from the switcher connects to it, with its steps over the Dashboard', async () => {
    renderApp();
    await connectFromHome();
    await go('#/pod?ns=default');
    await waitFor(() => expect(screen.getByTestId('rv')).toBeInTheDocument());
    const { postJson } = await import('./lib/api');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Switch cluster/ }));
    const menu = await screen.findByRole('menu', { name: 'Switch cluster' });
    // "other-cluster" is not pinned: it is listed under the All contexts heading.
    await user.click(within(menu).getByRole('menuitemcheckbox', { name: 'other-cluster' }));
    expect(postJson).toHaveBeenCalledWith('/api/config/context', { contextName: 'other-cluster' });
    await waitFor(() => expect(window.location.hash).toBe('#/cluster'));
    // Overlay inside <main> (sidebar + top bar stay), naming the target cluster.
    const main = screen.getByRole('main');
    await waitFor(() => expect(within(main).getByRole('list', { name: 'Connection steps' })).toBeInTheDocument());
    expect(main).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Connected to other-cluster')).toBeInTheDocument());
  }, 15000);

  it('"Search contexts…" and the kubepilot:open-contexts event open the searchable context picker', async () => {
    renderApp();
    const user = await connectFromHome();
    await user.click(screen.getByRole('button', { name: /Switch cluster/ }));
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Search contexts…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Switch cluster' });
    const search = within(dialog).getByRole('combobox');
    await waitFor(() => expect(search).toHaveFocus());
    expect(within(dialog).getAllByRole('option').map((o) => o.textContent)).toEqual(['other-cluster', 'test-cluster']);
    expect(within(dialog).getByRole('option', { name: 'test-cluster' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Switch cluster' })).toBeNull());

    // Desktop app path (native Clusters menu → App): same dialog.
    await act(async () => { window.dispatchEvent(new CustomEvent('kubepilot:host', { detail: { type: 'open-contexts' } })); });
    expect(await screen.findByRole('dialog', { name: 'Switch cluster' })).toBeInTheDocument();
    await user.type(screen.getByRole('combobox'), 'oth');
    expect(within(screen.getByRole('dialog', { name: 'Switch cluster' })).getAllByRole('option')).toHaveLength(1);
    await user.keyboard('{Enter}');
    const { postJson } = await import('./lib/api');
    expect(postJson).toHaveBeenCalledWith('/api/config/context', { contextName: 'other-cluster' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Switch cluster' })).toBeNull());
  }, 15000);

  it('restores the view, namespace filter and selection from the hash (once connected)', async () => {
    renderApp();
    await connectFromHome();
    await go('#/pod/default/web-1?ns=default');
    await waitFor(() => expect(screen.getByTestId('rv')).toHaveAttribute('data-selected', 'web-1'));
    expect(screen.getByTestId('rv')).toHaveAttribute('data-count', '1');
    expect(document.title).toMatch(/^Pods · default · test-cluster — K8Board$/);
    // Partial results from the backend surface as a non-blocking toast.
    window.location.hash = '#/pod';
    await settle();
    await waitFor(() => expect(screen.getByText(/Some resources could not be loaded/)).toBeInTheDocument());
  });

  it('routes sub-views and custom resources from params', async () => {
    renderApp();
    await connectFromHome();
    await go('#/security/images');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Security images' })).toBeInTheDocument());
    await act(async () => { window.location.hash = '#/customResources/cert-manager.io/v1/certificates/default/my-cert'; await new Promise((r) => setTimeout(r, 20)); });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'CR certificates/my-cert' })).toBeInTheDocument());
    await act(async () => { window.location.hash = '#/nodes/node-a'; await new Promise((r) => setTimeout(r, 20)); });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Nodes node-a' })).toBeInTheDocument());
  });

  it('the sidebar gear opens Preferences, and a second click closes it back to the page you were on', async () => {
    renderApp();
    const user = await connectFromHome();
    await user.click(screen.getByRole('link', { name: 'Pods' }));
    await waitFor(() => expect(screen.getByTestId('rv')).toHaveAttribute('data-type', 'pod'));
    const gear = () => within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('button', { name: 'Preferences' });
    expect(gear()).toHaveAttribute('aria-pressed', 'false');

    await user.click(gear());
    await waitFor(() => expect(window.location.hash).toBe('#/preferences/kubernetes'));
    expect(gear()).toHaveAttribute('aria-pressed', 'true');
    expect(gear()).toHaveAttribute('title', 'Close preferences');

    await user.click(gear());
    await waitFor(() => expect(window.location.hash).toBe('#/pod'));
    await waitFor(() => expect(screen.getByTestId('rv')).toHaveAttribute('data-type', 'pod'));
    expect(gear()).toHaveAttribute('aria-pressed', 'false');
  }, 15000);

  it('opens the command palette with Ctrl+K and the shortcuts sheet with ?', async () => {
    renderApp();
    const user = await connectFromHome();
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull());
    await user.keyboard('?');
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });
});
