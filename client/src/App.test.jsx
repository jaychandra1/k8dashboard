import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { _resetHistoryIndex } from './hooks/useHashRoute';

// ---- mocks ---------------------------------------------------------------
const responses = {
  '/api/config/status': { loaded: true, contexts: ['demo-cluster'], contextsInfo: [{ name: 'demo-cluster', provider: 'demo' }], currentContext: 'demo-cluster' },
  '/api/config/auth': { ok: true, currentContext: 'demo-cluster' },
  '/api/namespaces': { namespaces: ['default', 'kube-system'] },
  '/api/argocd/status': { installed: false },
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

  it('boots into the overview and navigates by changing the hash', async () => {
    renderApp();
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument());
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
    expect(screen.getByRole('banner')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('overview')).toHaveAttribute('data-pods', '2'));
    expect(document.title).toMatch(/^Overview · all namespaces · demo-cluster — KubePilot$/);

    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: 'Pods' }));
    expect(window.location.hash).toBe('#/pod');
    await waitFor(() => expect(screen.getByTestId('rv')).toHaveAttribute('data-type', 'pod'));
    expect(screen.getByRole('link', { name: 'Pods' })).toHaveAttribute('aria-current', 'page');
    expect(document.title).toMatch(/^Pods · all namespaces · demo-cluster — KubePilot$/);

    // Back button in the top bar → previous view.
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.getByTestId('overview')).toBeInTheDocument());
    // The first entry was the bare URL (no hash) — both spellings mean "overview".
    expect(['', '#/overview']).toContain(window.location.hash);
    expect(screen.getByRole('button', { name: 'Forward' })).toBeEnabled();
  }, 15000);

  it('restores the view, namespace filter and selection from the hash', async () => {
    window.location.hash = '#/pod/default/web-1?ns=default';
    renderApp();
    await waitFor(() => expect(screen.getByTestId('rv')).toHaveAttribute('data-selected', 'web-1'));
    expect(screen.getByTestId('rv')).toHaveAttribute('data-count', '1');
    expect(document.title).toMatch(/^Pods · default · demo-cluster — KubePilot$/);
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
