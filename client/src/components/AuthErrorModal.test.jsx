import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AuthErrorModal, { classify } from './AuthErrorModal';

vi.mock('../lib/api', async (orig) => {
  const actual = await orig();
  return { ...actual, getJson: vi.fn(), postJson: vi.fn() };
});
import { getJson, postJson } from '../lib/api';

const SSO_STDERR = 'kubepilot token-helper: The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login --profile sso-prod';
const SLOW = { timeout: 5000 };

describe('AuthErrorModal classify — backend helper reasons', () => {
  it('maps sso-expired to the AWS title with a sign-in action', () => {
    const c = classify({ reason: 'sso-expired', message: 'Your AWS SSO session has expired. Sign in again to refresh it.', detail: SSO_STDERR });
    expect(c.title).toBe('AWS session expired');
    expect(c.fix).toMatchObject({ kind: 'aws', label: 'Sign in with AWS', command: 'aws sso login --profile sso-prod' });
    expect(c.provider).toBe('aws');
    expect(c.unmatched).toBeUndefined();
  });

  it('maps exec-helper to the helper title with Retry guidance', () => {
    const c = classify({ reason: 'exec-helper', message: 'The kubeconfig auth helper for this cluster failed to run. Its kubeconfig entry was out of date and has been repaired — click Retry.', detail: 'SyntaxError: Unexpected end of JSON input' });
    expect(c.title).toBe('Cluster auth helper failed');
    expect(c.summary).toMatch(/repaired/);
    expect(c.fix.kind).toBe('note');
  });

  it('guesses the provider from the API server', () => {
    expect(classify({ reason: 'unreachable', server: 'https://abc.hcp.westeurope.azmk8s.io:443' }).provider).toBe('azure');
    expect(classify({ reason: 'unreachable', server: 'https://10.0.0.1:6443' }).provider).toBeNull();
  });

  it('unreachable: the hint follows the endpoint the backend saw (public / private / DNS / local)', () => {
    const at = (network) => classify({ reason: 'unreachable', message: 'm', network, server: 'https://x.gr7.eu-west-1.eks.amazonaws.com' });
    const pub = at({ endpoint: 'public', failure: 'timeout' });
    expect(pub.title).toBe('Cluster unreachable');
    expect(pub.provider).toBe('aws');
    expect(pub.fix.note).toMatch(/resolves to its public endpoint.*Tailscale or a VPN.*split DNS.*allowed public-access IP ranges/);
    expect(at({ endpoint: 'private', failure: 'timeout' }).fix.note).toMatch(/private endpoint.*Connect to Tailscale or the VPN/);
    expect(at({ endpoint: 'unknown', failure: 'dns' }).fix.note).toMatch(/only reachable over Tailscale or a VPN/);
    expect(at({ endpoint: 'local', failure: 'refused' }).fix.note).toMatch(/Start the local cluster/);
    expect(at(undefined).fix.note).toMatch(/Check your network or VPN/);
  });

  it('an older backend\'s bare "fetch failed" still reads as unreachable, not as an AWS sign-in problem', () => {
    const c = classify({ reason: 'error', message: 'fetch failed', server: 'https://x.gr7.eu-west-1.eks.amazonaws.com' });
    expect(c.title).toBe('Cluster unreachable');
  });
});

const CONTEXTS = ['dev-env-cluster', 'qa-cluster', 'aks-prod', 'kind-local'];
const INFO = [
  { name: 'dev-env-cluster', provider: 'aws' }, { name: 'qa-cluster', provider: 'aws' },
  { name: 'aks-prod', provider: 'azure' }, { name: 'kind-local', provider: 'local' },
];
const AWS = { profile: 'sso-241533118296', startUrl: 'https://d-906600a9b0.awsapps.com/start', ssoRegion: 'us-east-1', sessionName: null, accountId: '241533118296', roleName: 'AdministratorAccess', expiredAt: null, canSignIn: true, browser: true };
const expiredAuth = (extra = {}) => ({ reason: 'sso-expired', message: 'Your AWS SSO session has expired. Sign in again to refresh it.', detail: SSO_STDERR, server: 'https://x.eks.amazonaws.com', currentContext: 'dev-env-cluster', aws: AWS, ...extra });

describe('AuthErrorModal rendering', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.spyOn(window, 'open').mockImplementation(() => null); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('sso-expired without sign-in details: the AWS button opens the add-cluster flow; raw stderr is under details', () => {
    const onAddAws = vi.fn();
    render(<AuthErrorModal auth={{ reason: 'sso-expired', message: 'x', detail: SSO_STDERR, server: 'https://x.eks.amazonaws.com' }} onRetry={() => {}} onAddAws={onAddAws} />);
    expect(screen.getByText('AWS session expired')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Sign in with AWS/ }));
    expect(onAddAws).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /^Retry$/ })).toBeInTheDocument();
    expect(screen.getByText(SSO_STDERR)).toBeInTheDocument();
  });

  it('cluster card: context, provider, masked account and role; nothing starts on its own', () => {
    render(<AuthErrorModal auth={expiredAuth({ aws: { ...AWS, expiredAt: new Date().toISOString() } })} onRetry={() => {}} contexts={CONTEXTS} contextsInfo={INFO} currentContext="dev-env-cluster" onSwitchContext={() => {}} />);
    const card = screen.getByRole('region', { name: 'dev-env-cluster connection' });
    expect(card).toHaveTextContent('dev-env-cluster');
    expect(card).toHaveTextContent('AWS EKS · Account ••••8296 · AdministratorAccess');
    expect(card).toHaveTextContent(/Ended \d/);
    expect(within(card).getByRole('button', { name: 'Sign in with AWS' })).toBeInTheDocument();
    expect(card).toHaveTextContent('Opens your AWS access portal in your browser');
    expect(postJson).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });

  it('shows nothing environment-identifying: no API server, portal, account or raw ids', () => {
    const auth = expiredAuth({
      server: 'https://49B8A64035E12DFA22A9C44C3ABF0985.gr7.eu-west-1.eks.amazonaws.com',
      detail: 'token-helper: profile=sso-241533118296 failed for https://d-906600a9b0.awsapps.com/start via 10.24.30.223. To refresh this SSO session run aws sso login --profile sso-241533118296',
    });
    const { container } = render(<AuthErrorModal auth={auth} onRetry={() => {}} />);
    const text = container.ownerDocument.body.textContent;
    for (const secret of ['49B8A64035E12DFA22A9C44C3ABF0985', '241533118296', 'd-906600a9b0', '10.24.30.223', 'API server']) {
      expect(text).not.toContain(secret);
    }
    // The command is shown masked but copied in full, so it still works.
    expect(screen.getByText('aws sso login --profile sso-••••8296')).toBeInTheDocument();
  });

  it('unreachable public endpoint: says so on the card, explains Tailscale/VPN, shows no hostname or address', () => {
    const auth = {
      reason: 'unreachable',
      message: "The cluster's public endpoint didn't answer (connection timed out).",
      detail: 'fetch failed (UND_ERR_CONNECT_TIMEOUT)',
      network: { endpoint: 'public', failure: 'timeout' },
      server: 'https://49B8A64035E12DFA22A9C44C3ABF0985.gr7.eu-west-1.eks.amazonaws.com',
      currentContext: 'tr-prod-cashierbackend',
    };
    const { container } = render(<AuthErrorModal auth={auth} onRetry={() => {}} contexts={['tr-prod-cashierbackend', 'dev-env-cluster']} contextsInfo={[{ name: 'tr-prod-cashierbackend', provider: 'aws' }, { name: 'dev-env-cluster', provider: 'aws' }]} currentContext="tr-prod-cashierbackend" onSwitchContext={() => {}} />);
    expect(screen.getByText('Cluster unreachable')).toBeInTheDocument();
    expect(screen.getByText("The cluster's public endpoint didn't answer (connection timed out).")).toBeInTheDocument();
    const card = screen.getByRole('region', { name: 'tr-prod-cashierbackend connection' });
    expect(card).toHaveTextContent('AWS EKS · Public endpoint');
    expect(card).toHaveTextContent(/Tailscale or a VPN/);
    expect(screen.getByText('fetch failed (UND_ERR_CONNECT_TIMEOUT)')).toBeInTheDocument(); // Technical details
    const text = container.ownerDocument.body.textContent;
    expect(text).not.toContain('49B8A64035E12DFA22A9C44C3ABF0985');
    expect(text).not.toContain('eks.amazonaws.com');
  });

  it('unreachable private endpoint: "Private endpoint" on the card and a connect-your-VPN hint', () => {
    render(<AuthErrorModal auth={{ reason: 'unreachable', message: "The cluster's private endpoint didn't answer (connection timed out).", network: { endpoint: 'private', failure: 'timeout' }, server: 'https://x.gr7.eu-west-1.eks.amazonaws.com', currentContext: 'dev-env-cluster' }} onRetry={() => {}} contextsInfo={INFO} currentContext="dev-env-cluster" />);
    const card = screen.getByRole('region', { name: 'dev-env-cluster connection' });
    expect(card).toHaveTextContent('AWS EKS · Private endpoint');
    expect(card).toHaveTextContent(/Connect to Tailscale or the VPN that routes to that network/);
  });

  it('signs in right here: browser step, then reconnects automatically', async () => {
    postJson.mockResolvedValueOnce({ status: 'pending', method: 'browser', authUrl: 'https://oidc.us-east-1.amazonaws.com/authorize?x=1', startUrl: AWS.startUrl, expiresAt: new Date(Date.now() + 300000).toISOString() });
    getJson.mockResolvedValue({ status: 'done', converted: ['sso-241533118296'], session: 'kubepilot-d-906600a9b0' });
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(<AuthErrorModal auth={expiredAuth()} onRetry={onRetry} contexts={CONTEXTS} contextsInfo={INFO} currentContext="dev-env-cluster" onSwitchContext={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Sign in with AWS' }));
    expect(postJson).toHaveBeenCalledWith('/api/aws/sso-login', { profile: 'sso-241533118296', startUrl: AWS.startUrl, ssoRegion: 'us-east-1', method: undefined });
    expect(await screen.findByText('Finish signing in in your browser')).toBeInTheDocument();
    expect(window.open).toHaveBeenCalledWith('https://oidc.us-east-1.amazonaws.com/authorize?x=1', '_blank', 'noopener,noreferrer');
    expect(await screen.findByText('Signed in to AWS', {}, SLOW)).toBeInTheDocument();
    expect(screen.getByText('Reconnecting to dev-env-cluster…')).toBeInTheDocument();
    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1), SLOW);
  });

  it('"Use a sign-in code instead" shows the code; Cancel stops the sign-in on the server', async () => {
    postJson.mockImplementation(async (url, body) => {
      if (url === '/api/aws/sso-login') return { status: 'pending', method: body.method === 'device' ? 'device' : 'browser', userCode: 'WDKJ-QPLM', verificationUrl: 'https://device.sso.us-east-1.amazonaws.com/?user_code=WDKJ-QPLM', authUrl: 'https://oidc.us-east-1.amazonaws.com/authorize' };
      return { ok: true };
    });
    getJson.mockResolvedValue({ status: 'pending', method: 'device', userCode: 'WDKJ-QPLM', verificationUrl: 'https://device.sso.us-east-1.amazonaws.com/?user_code=WDKJ-QPLM' });
    const user = userEvent.setup();
    render(<AuthErrorModal auth={expiredAuth()} onRetry={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Use a sign-in code instead' }));
    expect(postJson).toHaveBeenCalledWith('/api/aws/sso-login', expect.objectContaining({ method: 'device' }));
    expect(await screen.findByLabelText('Sign-in code WDKJ-QPLM')).toHaveTextContent('WDKJ-QPLM');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(postJson).toHaveBeenLastCalledWith('/api/aws/sso-login/cancel');
    expect(screen.getByRole('button', { name: 'Sign in with AWS' })).toBeInTheDocument();
  });

  it('a failed sign-in explains itself and offers Try again', async () => {
    postJson.mockResolvedValueOnce({ status: 'pending', method: 'browser', authUrl: 'https://oidc.us-east-1.amazonaws.com/authorize' });
    getJson.mockResolvedValue({ status: 'error', method: 'browser', errorCode: 'denied', error: 'AWS denied the sign-in.' });
    const user = userEvent.setup();
    render(<AuthErrorModal auth={expiredAuth()} onRetry={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Sign in with AWS' }));
    expect(await screen.findByRole('alert', {}, SLOW)).toHaveTextContent('AWS denied the sign-in.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use a sign-in code instead' })).toBeInTheDocument();
  });

  it('any other cluster stays one click away: switching cancels a sign-in in progress', async () => {
    postJson.mockImplementation(async (url) => (url === '/api/aws/sso-login' ? { status: 'pending', method: 'browser', authUrl: 'https://oidc.us-east-1.amazonaws.com/authorize' } : { ok: true }));
    getJson.mockResolvedValue({ status: 'pending', method: 'browser' });
    const onSwitchContext = vi.fn();
    const user = userEvent.setup();
    render(<AuthErrorModal auth={expiredAuth()} onRetry={() => {}} contexts={CONTEXTS} contextsInfo={INFO} currentContext="dev-env-cluster" onSwitchContext={onSwitchContext} />);
    expect(screen.getByText('Or open a different cluster')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign in with AWS' }));
    await screen.findByText('Finish signing in in your browser');
    await user.click(screen.getByText('aks-prod'));
    expect(onSwitchContext).toHaveBeenCalledWith('aks-prod');
    expect(postJson).toHaveBeenLastCalledWith('/api/aws/sso-login/cancel');
  });

  it('with nothing to switch to, offers AWS, Azure and kubeconfig (GKE, on-prem) tiles', async () => {
    const onAddAzure = vi.fn();
    const onChangeConfig = vi.fn();
    const user = userEvent.setup();
    render(<AuthErrorModal auth={expiredAuth()} onRetry={() => {}} contexts={['dev-env-cluster']} onSwitchContext={() => {}} onAddAws={() => {}} onAddAzure={onAddAzure} onChangeConfig={onChangeConfig} />);
    expect(screen.getByText('Or connect a different cluster')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Azure AKS/ }));
    expect(onAddAzure).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /Kubeconfig.*GKE, on-prem/ }));
    expect(onChangeConfig).toHaveBeenCalled();
  });

  it('exec-helper: title, note and Retry as the only primary action', () => {
    const onRetry = vi.fn();
    render(<AuthErrorModal auth={{ reason: 'exec-helper', message: 'The kubeconfig auth helper for this cluster failed to run. Click Retry; if it keeps failing, re-import the cluster from Add cluster.', detail: 'Unexpected end of JSON input' }} onRetry={onRetry} onAddAws={() => {}} />);
    expect(screen.getByText('Cluster auth helper failed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sign in/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Retry$/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('offers only real-cluster paths: Add cluster and Retry, never a Demo button', () => {
    render(<AuthErrorModal auth={{ reason: 'error', message: 'connection refused' }} onRetry={() => {}} onAddAws={() => {}} onAddAzure={() => {}} onChangeConfig={() => {}} />);
    expect(screen.getByRole('button', { name: /Add cluster/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Retry$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /demo/i })).toBeNull();
    expect(screen.queryByText(/demo/i)).toBeNull();
  });
});
