import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor, within } from '@testing-library/react';
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
vi.mock('./components/Overview', () => ({ default: (p) => <div data-testid="overview" data-pods={(p.allResources.pods || []).length}><h1>Overview</h1></div> }));
vi.mock('./components/Cluster', () => ({ default: () => <h1>Cluster</h1> }));
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

describe('App routing', () => {
  beforeEach(() => { _resetHistoryIndex(); window.location.hash = ''; localStorage.clear(); });

  it('boots into the Cluster overview and navigates by changing the hash', async () => {
    renderApp();
    // Startup: branded loading screen until config status + auth are in.
    expect(screen.getByRole('status')).toHaveTextContent('Getting the data');
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument());
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
    expect(screen.getByRole('banner')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Cluster' })).toBeInTheDocument());
    expect(screen.queryByTestId('overview')).toBeNull();
    expect(document.title).toMatch(/^Cluster · test-cluster — KubePilot$/);
    // The sidebar has no context selector any more; the top bar switcher is the one place.
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(nav.querySelector('.nav-context-selector, .nav-cluster')).toBeNull();
    expect(screen.getByRole('button', { name: /Switch cluster/ })).toHaveTextContent('test-cluster');

    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: 'Pods' }));
    expect(window.location.hash).toBe('#/pod');
    await waitFor(() => expect(screen.getByTestId('rv')).toHaveAttribute('data-type', 'pod'));
    expect(screen.getByRole('link', { name: 'Pods' })).toHaveAttribute('aria-current', 'page');
    expect(document.title).toMatch(/^Pods · all namespaces · test-cluster — KubePilot$/);

    // Back button in the top bar → previous view.
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Cluster' })).toBeInTheDocument());
    // The first entry was the bare URL (no hash) — both spellings mean the landing view.
    expect(['', '#/cluster']).toContain(window.location.hash);
    expect(screen.getByRole('button', { name: 'Forward' })).toBeEnabled();
  }, 15000);

  it('the workloads overview is still reachable at #/overview', async () => {
    window.location.hash = '#/overview';
    renderApp();
    await waitFor(() => expect(screen.getByTestId('overview')).toHaveAttribute('data-pods', '2'));
    expect(document.title).toMatch(/^Overview · all namespaces · test-cluster — KubePilot$/);
  });

  it('switching cluster from the top-bar menu lands on the Cluster overview behind the branded loading screen', async () => {
    window.location.hash = '#/pod?ns=default';
    renderApp();
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
    await waitFor(() => expect(within(main).getByText('Getting the data from other-cluster…')).toBeInTheDocument());
    expect(main).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Switched to other-cluster')).toBeInTheDocument());
  }, 15000);

  it('"Search contexts…" and the kubepilot:open-contexts event open the searchable context picker', async () => {
    renderApp();
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument());
    const user = userEvent.setup();
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

  it('restores the view, namespace filter and selection from the hash', async () => {
    window.location.hash = '#/pod/default/web-1?ns=default';
    renderApp();
    await waitFor(() => expect(screen.getByTestId('rv')).toHaveAttribute('data-selected', 'web-1'));
    expect(screen.getByTestId('rv')).toHaveAttribute('data-count', '1');
    expect(document.title).toMatch(/^Pods · default · test-cluster — KubePilot$/);
    // Partial results from the backend surface as a non-blocking toast.
    window.location.hash = '#/pod';
    await settle();
    await waitFor(() => expect(screen.getByText(/Some resources could not be loaded/)).toBeInTheDocument());
  });

  it('routes sub-views and custom resources from params', async () => {
    window.location.hash = '#/security/images';
    renderApp();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Security images' })).toBeInTheDocument());
    await act(async () => { window.location.hash = '#/customResources/cert-manager.io/v1/certificates/default/my-cert'; await new Promise((r) => setTimeout(r, 20)); });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'CR certificates/my-cert' })).toBeInTheDocument());
    await act(async () => { window.location.hash = '#/nodes/node-a'; await new Promise((r) => setTimeout(r, 20)); });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Nodes node-a' })).toBeInTheDocument());
  });

  it('opens the command palette with Ctrl+K and the shortcuts sheet with ?', async () => {
    renderApp();
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument());
    const user = userEvent.setup();
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull());
    await user.keyboard('?');
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });
});
