import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GkeIntegration from './GkeIntegration';
import { maskEmail } from '../lib/redact';

vi.mock('../lib/api', async (orig) => {
  const actual = await orig();
  return { ...actual, getJson: vi.fn(), postJson: vi.fn() };
});
import { getJson, postJson, ApiError } from '../lib/api';

const SLOW = { timeout: 6000 };
const CLUSTERS = [
  { project: 'shop-dev-1', projectName: 'Shop Dev', name: 'web', location: 'us-central1', status: 'RUNNING', version: '1.31.4-gke.100', private: false, imported: false, conflict: true },
  { project: 'shop-prod-1', projectName: 'Shop Prod', name: 'batch', location: 'europe-west1-b', status: 'RUNNING', version: '1.31.4-gke.100', private: true, imported: false, conflict: false },
  { project: 'shop-prod-1', projectName: 'Shop Prod', name: 'web', location: 'europe-west1', status: 'RUNNING', version: '1.31.4-gke.100', private: false, imported: true, conflict: false },
  { project: 'shop-prod-1', projectName: 'Shop Prod', name: 'api', location: 'europe-west1', status: 'PROVISIONING', version: '', private: false, imported: false, conflict: false },
];
const STATUS = { installed: true, loggedIn: true, account: 'jane.doe@example.com', accounts: [{ account: 'jane.doe@example.com', active: true }, { account: 'ops@example.com', active: false }] };
const route = (routes) => (url) => {
  const key = url.split('?')[0];
  if (!(key in routes)) return Promise.reject(new Error(`unexpected GET ${url}`));
  const v = routes[key];
  return typeof v === 'function' ? v(url) : Promise.resolve(v);
};

describe('GkeIntegration', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('without gcloud: says what is missing and where to get it; Retry checks again', async () => {
    getJson.mockImplementation(route({ '/api/gke/status': { installed: false, accounts: [], account: null, loggedIn: false } }));
    const user = userEvent.setup();
    render(<GkeIntegration onClose={() => {}} />);
    const dlg = await screen.findByRole('dialog', { name: 'Add Google GKE clusters' }, SLOW);
    expect(dlg).toHaveTextContent('isn’t installed, or isn’t on PATH'.replace(/’/g, "'"));
    expect(within(dlg).getByRole('link', { name: 'cloud.google.com/sdk' })).toHaveAttribute('href', 'https://cloud.google.com/sdk/docs/install');
    await user.click(within(dlg).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(getJson).toHaveBeenCalledTimes(2));
  });

  it('signed out: "Sign in with Google" runs the gcloud sign-in, then lists the clusters', async () => {
    let signedIn = false;
    getJson.mockImplementation(route({
      '/api/gke/status': () => Promise.resolve(signedIn ? STATUS : { installed: true, accounts: [], account: null, loggedIn: false }),
      '/api/gke/login/status': () => { signedIn = true; return Promise.resolve({ status: 'done' }); },
      '/api/gke/clusters': { clusters: CLUSTERS, projects: 3, skipped: 1 },
    }));
    postJson.mockResolvedValue({ status: 'pending' });
    const user = userEvent.setup();
    render(<GkeIntegration onClose={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Sign in with Google' }, SLOW));
    expect(postJson).toHaveBeenCalledWith('/api/gke/login');
    expect(await screen.findByText(/A browser window opened for Google sign-in/)).toBeInTheDocument();
    expect(await screen.findByRole('group', { name: 'GKE clusters' }, SLOW)).toBeInTheDocument();
    expect(getJson).toHaveBeenCalledWith('/api/gke/clusters', { params: { account: 'jane.doe@example.com' } });
  });

  it('lists every project\'s clusters; adds only the chosen ones, by name (no endpoint leaves the server)', async () => {
    getJson.mockImplementation(route({ '/api/gke/status': STATUS, '/api/gke/clusters': { clusters: CLUSTERS, projects: 3, skipped: 1 } }));
    postJson.mockResolvedValue({ imported: ['batch'], updated: [], failed: [], contexts: ['batch', 'web'] });
    const onImported = vi.fn();
    const user = userEvent.setup();
    render(<GkeIntegration onClose={() => {}} onImported={onImported} />);
    const list = await screen.findByRole('group', { name: 'GKE clusters' }, SLOW);
    expect(screen.getByText(/4 clusters · 3 projects/)).toHaveTextContent('1 skipped');
    // Account names are masked.
    expect(within(screen.getByRole('combobox', { name: 'Google account' })).getAllByRole('option').map((o) => o.textContent)).toEqual(['j••••@example.com', 'o••••@example.com']);
    expect(document.body.textContent).not.toMatch(/jane\.doe/);
    // Already added, a name another cluster holds, private, still starting.
    const row = (label) => within(list).getByRole('checkbox', { name: label }).closest('label');
    expect(row('web in Shop Prod')).toHaveTextContent('Added');
    expect(within(list).getByRole('checkbox', { name: 'web in Shop Prod' })).toBeDisabled();
    expect(row('web in Shop Dev')).toHaveTextContent('Name in use');
    expect(within(list).getByRole('checkbox', { name: 'web in Shop Dev' })).toBeDisabled();
    expect(row('batch in Shop Prod')).toHaveTextContent('Shop Prod · europe-west1-b · v1.31.4-gke.100');
    expect(row('batch in Shop Prod')).toHaveTextContent('Private');
    expect(row('api in Shop Prod')).toHaveTextContent('PROVISIONING');
    // Both addable clusters start selected; drop one.
    await user.click(within(list).getByRole('checkbox', { name: 'api in Shop Prod' }));
    await user.click(screen.getByRole('button', { name: 'Add 1 cluster' }));
    await waitFor(() => expect(postJson).toHaveBeenCalledWith('/api/gke/import', { clusters: [{ project: 'shop-prod-1', location: 'europe-west1-b', name: 'batch' }] }));
    expect(await screen.findByRole('status', {}, SLOW)).toHaveTextContent('1 cluster added to your kubeconfig.');
    expect(onImported).toHaveBeenCalledWith(['batch', 'web']);
  });

  it('another account lists that account\'s clusters; an expired Google sign-in asks to sign in again', async () => {
    getJson.mockImplementation(route({
      '/api/gke/status': STATUS,
      '/api/gke/clusters': (url) => (url.includes('ops') || getJson.mock.calls.some(([, o]) => o?.params?.account === 'ops@example.com')
        ? Promise.reject(new ApiError({ status: 401, code: 'not_signed_in', message: 'gcloud is not signed in. Sign in with Google (gcloud auth login), then try again.', url }))
        : Promise.resolve({ clusters: CLUSTERS, projects: 3, skipped: 0 })),
    }));
    const user = userEvent.setup();
    render(<GkeIntegration onClose={() => {}} />);
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Google account' }, SLOW), 'ops@example.com');
    expect(getJson).toHaveBeenCalledWith('/api/gke/clusters', { params: { account: 'ops@example.com' } });
    expect(await screen.findByRole('alert', {}, SLOW)).toHaveTextContent('gcloud is not signed in');
    expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument();
  });

  it('maskEmail', () => {
    expect(maskEmail('jane.doe@example.com')).toBe('j••••@example.com');
    expect(maskEmail('sa-1@proj.iam.gserviceaccount.com')).toBe('s••••@proj.iam.gserviceaccount.com');
    expect(maskEmail('not an email')).toBe('not an email');
    expect(maskEmail('')).toBe('');
  });
});
