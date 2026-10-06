import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AwsIntegration, { isUpdatable } from './AwsIntegration';

vi.mock('../lib/api', async (orig) => {
  const actual = await orig();
  return { ...actual, getJson: vi.fn(), postJson: vi.fn() };
});
import { getJson, postJson } from '../lib/api';

const rowOf = (name) => screen.getByText(name, { selector: '.azure-cname' }).closest('label');

function setup() {
  const onClose = vi.fn();
  const onImported = vi.fn();
  render(<AwsIntegration onClose={onClose} onImported={onImported} />);
  return { onClose, onImported, user: userEvent.setup() };
}

describe('isUpdatable', () => {
  it('is true only for an added cluster of the same identity that uses other credentials', () => {
    expect(isUpdatable({ imported: true, current: false })).toBe(true);
    expect(isUpdatable({ imported: true, current: true })).toBe(false);
    expect(isUpdatable({ imported: true, conflict: true })).toBe(false);
    expect(isUpdatable({ imported: true })).toBe(false); // older server: no status → locked as before
    expect(isUpdatable({ imported: false })).toBe(false);
  });
});

describe('AwsIntegration — clusters that are already added', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getJson.mockImplementation(async (url) => {
      if (url === '/api/aws/status') return { installed: true, profiles: ['team'], profileDetails: [{ name: 'team', type: 'access-key' }] };
      throw new Error(`unexpected GET ${url}`);
    });
    postJson.mockImplementation(async (url) => {
      if (url === '/api/aws/clusters') {
        return {
          regions: 1,
          clusters: [
            { name: 'dev', region: 'eu-west-1', imported: true, current: true },
            { name: 'legacy', region: 'eu-west-1', imported: true, current: false },
            { name: 'other', region: 'eu-west-1', imported: true, conflict: true },
          ],
        };
      }
      if (url === '/api/aws/import') return { imported: ['legacy'], updated: ['legacy'], failed: [], contexts: ['dev', 'legacy', 'other'] };
      throw new Error(`unexpected POST ${url}`);
    });
  });

  it('labels each cluster and offers "Done" instead of a disabled "Add 0 clusters"', async () => {
    const { user, onClose, onImported } = setup();
    await user.click(await screen.findByRole('button', { name: /already signed in, just discover clusters/ }));
    await screen.findByText('dev', { selector: '.azure-cname' });

    const dev = rowOf('dev');
    expect(within(dev).getByText('Uses this sign-in')).toBeInTheDocument();
    expect(within(dev).getByRole('checkbox')).toBeDisabled();
    expect(within(dev).getByRole('checkbox')).toBeChecked();

    const other = rowOf('other');
    expect(within(other).getByText('Name in use')).toBeInTheDocument();
    expect(within(other).getByRole('checkbox')).toBeDisabled();
    expect(within(other).getByRole('checkbox')).not.toBeChecked();
    expect(other).toHaveTextContent(/different cluster named/);

    const legacy = rowOf('legacy');
    expect(within(legacy).getByRole('checkbox')).toBeEnabled();
    expect(within(legacy).getByRole('checkbox')).not.toBeChecked();
    expect(legacy).toHaveTextContent(/select to switch it to this sign-in/);

    expect(screen.queryByRole('button', { name: /Add 0 clusters/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onImported).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('updates an added cluster to the current sign-in and reports it as switched', async () => {
    const { user } = setup();
    await user.click(await screen.findByRole('button', { name: /already signed in, just discover clusters/ }));
    await screen.findByText('legacy', { selector: '.azure-cname' });
    const legacy = rowOf('legacy');
    await user.click(within(legacy).getByRole('checkbox'));
    expect(within(legacy).getByText('Will update')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Update 1 cluster' }));
    expect(postJson).toHaveBeenCalledWith('/api/aws/import', { clusters: [{ name: 'legacy', region: 'eu-west-1' }], profile: 'team' });
    expect(await screen.findByText(/switched to this sign-in/)).toHaveTextContent('1 cluster switched to this sign-in.');
    expect(screen.queryByText(/added to your kubeconfig/)).toBeNull();
  });
});

describe('AwsIntegration — after an AWS SSO sign-in', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getJson.mockImplementation(async (url) => {
      if (url === '/api/aws/status') return { installed: true, profiles: [], profileDetails: [] };
      if (url === '/api/aws/sso-login/status') return { status: 'done' };
      if (url === '/api/aws/sso-accounts') return { accounts: [{ accountId: '111122223333', accountName: 'Dev' }] };
      if (url === '/api/aws/sso-roles') return { roles: ['Admin'] };
      throw new Error(`unexpected GET ${url}`);
    });
    postJson.mockImplementation(async (url) => {
      if (url === '/api/aws/sso-login') return { userCode: 'ABCD-EFGH', verificationUrl: 'https://device.sso.example/' };
      if (url === '/api/aws/clusters') {
        return {
          regions: 1,
          clusters: [
            { name: 'dev-env-cluster', region: 'eu-west-1', account: '111122223333', imported: true, current: true },
            { name: 'pixdora-tech', region: 'eu-west-1', account: '111122223333', imported: true, current: true },
          ],
        };
      }
      throw new Error(`unexpected POST ${url}`);
    });
  });

  it('confirms the refreshed sign-in and that the added clusters reconnect with it', async () => {
    const { user, onImported } = setup();
    await user.type(await screen.findByLabelText('AWS SSO start URL'), 'https://my-org.awsapps.com/start');
    await user.click(screen.getByRole('button', { name: 'Sign in with AWS SSO' }));
    // The dialog polls the sign-in every 2 s.
    await user.click(await screen.findByRole('button', { name: 'Next' }, { timeout: 5000 }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));

    const banner = await screen.findByText(/Signed in to AWS SSO as/);
    expect(banner.closest('[role="status"]')).toHaveTextContent('Signed in to AWS SSO as Admin in Dev (111122223333).');
    expect(banner.closest('[role="status"]')).toHaveTextContent(/The 2 clusters marked “uses this sign-in” reconnect with it automatically/);
    expect(screen.getAllByText('Uses this sign-in')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Add 0 clusters/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(onImported).toHaveBeenCalled());
  }, 15000);
});
