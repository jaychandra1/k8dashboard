import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AwsSignIns, { signInStatus, signInTitle } from './AwsSignIns';

vi.mock('../lib/api', async (orig) => {
  const actual = await orig();
  return { ...actual, getJson: vi.fn(), postJson: vi.fn() };
});
import { getJson, postJson, onClusterAuthRequired } from '../lib/api';

const START = 'https://d-906600a9b0.awsapps.com/start';
const soon = () => new Date(Date.now() + 3600_000).toISOString();
// One sign-in per account: dev (two roles) signed in, prod not.
const DEV = {
  id: 'kubepilot-d-906600a9b0-111122223333', sessionName: 'kubepilot-d-906600a9b0-111122223333', legacy: false, managed: true,
  startUrl: START, signedIn: true, expiresAt: soon(), refreshable: true, accountId: '111122223333', accounts: 1, shared: false, canSplit: false,
  clusters: [
    { context: 'dev', current: true, profile: 'dev', accountId: '111122223333', roleName: 'Dev', own: true, canSplit: false },
    { context: 'dev-readonly', current: false, profile: 'dev-ro', accountId: '111122223333', roleName: 'ReadOnly', own: true, canSplit: false },
  ],
};
const PROD = {
  id: 'kubepilot-d-906600a9b0-444455556666', sessionName: 'kubepilot-d-906600a9b0-444455556666', legacy: false, managed: true,
  startUrl: START, signedIn: false, expiresAt: null, refreshable: false, accountId: '444455556666', accounts: 1, shared: false, canSplit: false,
  clusters: [{ context: 'prod', current: false, profile: 'prod', accountId: '444455556666', roleName: 'Admin', own: true, canSplit: false }],
};
// A session the user made in the AWS CLI: two accounts still share it.
const CLI = {
  id: 'corp', sessionName: 'corp', legacy: false, managed: false,
  startUrl: START, signedIn: true, expiresAt: soon(), refreshable: true, accountId: null, accounts: 2, shared: true, canSplit: true,
  clusters: [
    { context: 'qa', current: false, profile: 'qa', accountId: '222233334444', roleName: 'Dev', own: false, canSplit: true },
    { context: 'stage', current: false, profile: 'stage', accountId: '777788889999', roleName: 'Dev', own: false, canSplit: true },
  ],
};
const SLOW = { timeout: 5000 };
const card = async (title) => (await screen.findByText(title, {}, SLOW)).closest('.awsi-card');

describe('AwsSignIns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getJson.mockResolvedValue({ signIns: [DEV, PROD] });
    postJson.mockResolvedValue({ ok: true });
  });

  it('one card per AWS account, each with its own status; account ids and the start URL are masked', async () => {
    render(<AwsSignIns />);
    const dev = await card('Account ••••3333');
    const prod = await card('Account ••••6666');
    expect(within(dev).getByText(/^Signed in until/)).toBeInTheDocument();
    expect(within(prod).getByText('Not signed in — sign in when you open one of its clusters')).toBeInTheDocument();
    // Two roles of one account share that account's sign-in.
    const rows = within(within(dev).getByRole('list', { name: 'Clusters of Account ••••3333' })).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual(['devcurrentDev', 'dev-readonlyReadOnly']);
    expect(within(prod).getByRole('listitem')).toHaveTextContent('prodAdmin');
    expect(document.body.textContent).not.toMatch(/444455556666|111122223333|d-906600a9b0/);
    expect(screen.getByText(/Each AWS account has its own sign-in/)).toBeInTheDocument();
    // No production switch, and nothing offers to share a sign-in.
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Production|shared sign-in/i);
    expect(screen.queryByRole('button', { name: 'Use one sign-in per account' })).toBeNull();
  });

  it('sign out asks first (naming that account and its clusters) and cancel changes nothing', async () => {
    const user = userEvent.setup();
    render(<AwsSignIns />);
    const dev = await card('Account ••••3333');
    await user.click(within(dev).getByRole('button', { name: 'Sign out' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign out of account ••••3333?' }, SLOW);
    expect(dialog).toHaveTextContent('dev and dev-readonly will ask you to sign in again');
    expect(dialog).toHaveTextContent('Other accounts stay signed in');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(postJson).not.toHaveBeenCalled();
    await user.click(within(dev).getByRole('button', { name: 'Sign out' }));
    await user.click(within(await screen.findByRole('dialog', {}, SLOW)).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(postJson).toHaveBeenCalledWith('/api/aws/sessions/sign-out', { id: DEV.id }));
    await waitFor(() => expect(getJson).toHaveBeenCalledTimes(2));
  });

  it('signing out the open cluster\'s account asks for a sign-in right away; another account does not', async () => {
    const user = userEvent.setup();
    const needsSignIn = vi.fn();
    const off = onClusterAuthRequired(needsSignIn);
    getJson.mockResolvedValue({ signIns: [DEV, { ...PROD, signedIn: true, expiresAt: soon() }] });
    postJson.mockResolvedValueOnce({ ok: true, signedOut: true, clusters: ['prod'], current: false });
    render(<AwsSignIns />);
    await user.click(within(await card('Account ••••6666')).getByRole('button', { name: 'Sign out' }));
    await user.click(within(await screen.findByRole('dialog', {}, SLOW)).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(postJson).toHaveBeenCalledTimes(1));
    expect(needsSignIn).not.toHaveBeenCalled();
    postJson.mockResolvedValueOnce({ ok: true, signedOut: true, clusters: ['dev', 'dev-readonly'], current: true });
    await user.click(within(await card('Account ••••3333')).getByRole('button', { name: 'Sign out' }));
    await user.click(within(await screen.findByRole('dialog', {}, SLOW)).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(needsSignIn).toHaveBeenCalledTimes(1));
    off();
  });

  it('a sign-in from the AWS CLI that accounts share is split by account only when asked', async () => {
    const user = userEvent.setup();
    getJson.mockResolvedValue({ signIns: [DEV, CLI] });
    postJson.mockResolvedValueOnce({ moved: 2, clusters: ['qa', 'stage'], current: false });
    render(<AwsSignIns />);
    const cli = await card('AWS sign-in shared by 2 accounts');
    expect(cli).toHaveTextContent('from your AWS CLI configuration');
    expect(cli).toHaveTextContent('2 accounts share this sign-in');
    // Which account each cluster is in is shown while they share a sign-in.
    expect(within(cli).getAllByRole('listitem').map((r) => r.textContent)).toEqual(['qaAccount ••••4444 · Dev', 'stageAccount ••••9999 · Dev']);
    await user.click(within(cli).getByRole('button', { name: 'Use one sign-in per account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Use one sign-in per account?' }, SLOW);
    expect(dialog).toHaveTextContent('The AWS profiles of qa and stage in ~/.aws/config');
    expect(dialog).toHaveTextContent('a backup of the file is kept');
    expect(postJson).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Use one sign-in per account' }));
    await waitFor(() => expect(postJson).toHaveBeenCalledWith('/api/aws/sessions/split', { id: 'corp' }));
  });

  it('a failed change is reported', async () => {
    const user = userEvent.setup();
    postJson.mockRejectedValueOnce(new Error('disk full'));
    render(<AwsSignIns />);
    await user.click(within(await card('Account ••••3333')).getByRole('button', { name: 'Sign out' }));
    await user.click(within(await screen.findByRole('dialog', {}, SLOW)).getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert', {}, SLOW)).toHaveTextContent('disk full');
  });

  it('nothing to show without IAM Identity Center clusters', async () => {
    getJson.mockResolvedValue({ signIns: [] });
    render(<AwsSignIns />);
    expect(await screen.findByText(/No cluster in your kubeconfig signs in/, {}, SLOW)).toBeInTheDocument();
  });

  it('status text and titles', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(signInStatus({ signedIn: false, expiresAt: past, refreshable: true }).text).toMatch(/Renews when you open/);
    // AWS refused the renewal: the sign-in is over, whatever refresh token is still stored.
    expect(signInStatus({ signedIn: false, expiresAt: past, refreshable: false, renewalRefused: true }))
      .toEqual({ tone: 'warn', text: 'Expired — sign in when you open one of its clusters' });
    expect(signInStatus({ signedIn: false, expiresAt: null, refreshable: false }))
      .toEqual({ tone: 'warn', text: 'Not signed in — sign in when you open one of its clusters' });
    expect(signInTitle({ accountId: '111122223333', accounts: 1 })).toBe('Account ••••3333');
    expect(signInTitle({ accountId: null, accounts: 3 })).toBe('AWS sign-in shared by 3 accounts');
  });

  it('an expired sign-in can still be signed out (its token is on this computer); none stored, nothing to sign out', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    getJson.mockResolvedValue({ signIns: [{ ...DEV, signedIn: false, expiresAt: past, refreshable: false, renewalRefused: true }, PROD] });
    render(<AwsSignIns />);
    const dev = await card('Account ••••3333');
    expect(within(dev).getByText('Expired — sign in when you open one of its clusters')).toBeInTheDocument();
    expect(within(dev).getByRole('button', { name: 'Sign out' })).toBeEnabled();
    expect(within(await card('Account ••••6666')).getByRole('button', { name: 'Sign out' })).toBeDisabled();
  });
});
