import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AwsSignIns, { signInStatus } from './AwsSignIns';

vi.mock('../lib/api', async (orig) => {
  const actual = await orig();
  return { ...actual, getJson: vi.fn(), postJson: vi.fn() };
});
import { getJson, postJson } from '../lib/api';

const START = 'https://d-906600a9b0.awsapps.com/start';
const SHARED = {
  id: 'kubepilot-d-906600a9b0', sessionName: 'kubepilot-d-906600a9b0', legacy: false, production: false,
  startUrl: START, signedIn: true, expiresAt: new Date(Date.now() + 3600_000).toISOString(), refreshable: true,
  clusters: [
    { context: 'dev', current: true, profile: 'dev', accountId: '111122223333', roleName: 'Dev' },
    { context: 'prod', current: false, profile: 'prod', accountId: '444455556666', roleName: 'Admin' },
  ],
};
const SESSIONS = { signIns: [SHARED], legacyProfiles: [{ profile: 'cli-only', startUrl: START }] };
const SLOW = { timeout: 5000 };

describe('AwsSignIns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getJson.mockResolvedValue(SESSIONS);
    postJson.mockResolvedValue({ ok: true });
  });

  it('lists each sign-in with the clusters it reaches; account ids and the start URL are masked', async () => {
    render(<AwsSignIns />);
    const list = await screen.findByRole('list', { name: 'Clusters on this sign-in' }, SLOW);
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('.awsi-cluster-name').textContent)).toEqual(['devcurrent', 'prod']);
    expect(rows[1]).toHaveTextContent('Account ••••6666 · Admin');
    expect(document.body.textContent).not.toMatch(/444455556666|111122223333|d-906600a9b0/);
    expect(screen.getByText(/^Signed in until/)).toBeInTheDocument();
    expect(screen.getByText(/older format/)).toHaveTextContent('cli-only');
  });

  it('marking a cluster production asks first, then moves only that cluster', async () => {
    const user = userEvent.setup();
    render(<AwsSignIns />);
    const list = await screen.findByRole('list', { name: 'Clusters on this sign-in' }, SLOW);
    const prodRow = within(list).getAllByRole('listitem')[1];
    await user.click(within(prodRow).getByRole('checkbox', { name: 'Production' }));
    const dialog = await screen.findByRole('dialog', {}, SLOW);
    expect(dialog).toHaveTextContent('Mark prod as production?');
    expect(dialog).toHaveTextContent('signing in for other clusters will no longer give access to it');
    expect(postJson).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Mark as production' }));
    await waitFor(() => expect(postJson).toHaveBeenCalledWith('/api/aws/production', { context: 'prod', production: true }));
    await waitFor(() => expect(getJson).toHaveBeenCalledTimes(2));
  });

  it('sign out asks first (naming the clusters) and cancel changes nothing', async () => {
    const user = userEvent.setup();
    render(<AwsSignIns />);
    await user.click(await screen.findByRole('button', { name: 'Sign out' }, SLOW));
    const dialog = await screen.findByRole('dialog', {}, SLOW);
    expect(dialog).toHaveTextContent('dev and prod will ask you to sign in again');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(postJson).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await user.click(within(await screen.findByRole('dialog', {}, SLOW)).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(postJson).toHaveBeenCalledWith('/api/aws/sessions/sign-out', { id: SHARED.id }));
  });

  it('older-format profiles change only when asked', async () => {
    const user = userEvent.setup();
    render(<AwsSignIns />);
    await user.click(await screen.findByRole('button', { name: 'Use the shared sign-in for them' }, SLOW));
    await user.click(within(await screen.findByRole('dialog', {}, SLOW)).getByRole('button', { name: 'Update profiles' }));
    await waitFor(() => expect(postJson).toHaveBeenCalledWith('/api/aws/profiles/use-shared-sign-in', { startUrl: START, profiles: ['cli-only'] }));
  });

  it('a failed change is reported', async () => {
    const user = userEvent.setup();
    postJson.mockRejectedValueOnce(new Error('disk full'));
    render(<AwsSignIns />);
    await user.click(await screen.findByRole('button', { name: 'Sign out' }, SLOW));
    await user.click(within(await screen.findByRole('dialog', {}, SLOW)).getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert', {}, SLOW)).toHaveTextContent('disk full');
  });

  it('nothing to show without IAM Identity Center clusters', async () => {
    getJson.mockResolvedValue({ signIns: [], legacyProfiles: [] });
    render(<AwsSignIns />);
    expect(await screen.findByText(/No cluster in your kubeconfig signs in/, {}, SLOW)).toBeInTheDocument();
  });

  it('status text', () => {
    expect(signInStatus({ signedIn: false, refreshable: true }).text).toMatch(/Renews when you open/);
    expect(signInStatus({ signedIn: false, refreshable: false })).toEqual({ tone: 'warn', text: 'Signed out' });
  });
});
