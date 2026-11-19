import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SsoSignInPanel, useSsoSignIn } from './AwsSsoSignIn';

vi.mock('../lib/api', async (orig) => ({ ...(await orig()), getJson: vi.fn(), postJson: vi.fn() }));
import { getJson, postJson } from '../lib/api';

// The page the server offers for one sign-in, and AWS's own address (which that page opens).
const PAGE = 'http://127.0.0.1:61749/oauth/start/Zk3vQ9x_T1mB7c-pLr2aWd8eYh5uNs0f';
const AWS = 'https://oidc.us-east-1.amazonaws.com/authorize?client_id=x';
const SLOW = { timeout: 5000 };
const waiting = (over = {}) => ({ status: 'pending', method: 'browser', signInUrl: PAGE, authUrl: AWS, ...over });

function Panel({ onDone }) {
  const sso = useSsoSignIn({ onDone });
  return <SsoSignInPanel sso={sso} params={{ profile: 'dev' }} browser />;
}
const start = async () => {
  const user = userEvent.setup();
  const view = render(<Panel />);
  await user.click(screen.getByRole('button', { name: 'Sign in with AWS' }));
  return { user, ...view };
};

beforeEach(() => {
  vi.spyOn(window, 'open').mockImplementation(() => null);
  getJson.mockReset();
  postJson.mockReset();
  postJson.mockResolvedValue({ ok: true });
  getJson.mockResolvedValue(waiting());
});
afterEach(() => {
  cleanup();
  delete window.k8boardHost;
  vi.restoreAllMocks();
});

describe('AWS sign-in in the browser', () => {
  it("opens K8Board's own sign-in page (which opens AWS in a window that can close), and says what to do there", async () => {
    postJson.mockResolvedValueOnce(waiting());
    const { user } = await start();
    expect(await screen.findByText('Finish signing in in your browser')).toBeInTheDocument();
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(window.open).toHaveBeenCalledWith(PAGE, '_blank', 'noopener,noreferrer');
    expect(screen.getByText('Continue to AWS')).toBeInTheDocument();
    expect(screen.getByText(/The browser windows close by\s+themselves/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open sign-in page again' }));
    expect(window.open).toHaveBeenCalledTimes(2);
    expect(window.open).toHaveBeenLastCalledWith(PAGE, '_blank', 'noopener,noreferrer');
  });

  it('a server without that page: AWS opens directly, as before', async () => {
    postJson.mockResolvedValueOnce(waiting({ signInUrl: undefined }));
    await start();
    await screen.findByText('Finish signing in in your browser');
    expect(window.open).toHaveBeenCalledWith(AWS, '_blank', 'noopener,noreferrer');
  });

  it("opens nothing but https or this computer's one sign-in page", async () => {
    for (const url of [
      'http://127.0.0.1:61749/other',
      'http://127.0.0.1:61749/oauth/start/short',
      'http://127.0.0.1:61749/oauth/start/Zk3vQ9x_T1mB7c-pLr2aWd8eYh5uNs0f/../../x',
      'http://127.0.0.1:61749/oauth/start/Zk3vQ9x_T1mB7c-pLr2aWd8eYh5uNs0f?next=http://evil.example',
      'http://evil.example/oauth/start/Zk3vQ9x_T1mB7c-pLr2aWd8eYh5uNs0f',
      'http://127.0.0.1.evil.example:61749/oauth/start/Zk3vQ9x_T1mB7c-pLr2aWd8eYh5uNs0f',
      'http://localhost:61749/oauth/start/Zk3vQ9x_T1mB7c-pLr2aWd8eYh5uNs0f',
      'javascript:alert(1)',
      'file:///C:/Windows/win.ini',
    ]) {
      postJson.mockResolvedValueOnce(waiting({ signInUrl: url, authUrl: undefined }));
      await start();
      await screen.findByText('Finish signing in in your browser');
      expect(window.open, url).not.toHaveBeenCalled();
      cleanup();
    }
  });
});

describe('back to the app when the sign-in is over (desktop)', () => {
  it('signed in: the window comes to the front, once', async () => {
    const focusWindow = vi.fn();
    window.k8boardHost = { focusWindow };
    postJson.mockResolvedValueOnce(waiting());
    getJson.mockResolvedValue({ status: 'done', converted: [] });
    await start();
    expect(focusWindow).not.toHaveBeenCalled();
    expect(await screen.findByText('Signed in to AWS', {}, SLOW)).toBeInTheDocument();
    expect(focusWindow).toHaveBeenCalledTimes(1);
  });

  it('a sign-in code approved in the browser brings it forward too', async () => {
    const focusWindow = vi.fn();
    window.k8boardHost = { focusWindow };
    postJson.mockResolvedValueOnce({ status: 'pending', method: 'device', userCode: 'WDKJ-QPLM', verificationUrl: 'https://device.sso.us-east-1.amazonaws.com/?user_code=WDKJ-QPLM' });
    getJson.mockResolvedValue({ status: 'done', converted: [] });
    await start();
    expect(await screen.findByText('Signed in to AWS', {}, SLOW)).toBeInTheDocument();
    expect(focusWindow).toHaveBeenCalledTimes(1);
  });

  it('denied or failed in the browser: forward, to show why. Timed out (nobody was there): the app stays put', async () => {
    for (const [errorCode, times] of [['denied', 1], ['sign_in_failed', 1], ['timeout', 0], ['expired', 0]]) {
      const focusWindow = vi.fn();
      window.k8boardHost = { focusWindow };
      postJson.mockResolvedValueOnce(waiting());
      getJson.mockResolvedValue({ status: 'error', method: 'browser', errorCode, error: `It ended: ${errorCode}` });
      await start();
      expect(await screen.findByRole('alert', {}, SLOW)).toHaveTextContent(`It ended: ${errorCode}`);
      expect(focusWindow, errorCode).toHaveBeenCalledTimes(times);
      cleanup();
    }
  }, 20000);

  it('a sign-in that could not start never moves the window; outside the desktop app nothing is called', async () => {
    const focusWindow = vi.fn();
    window.k8boardHost = { focusWindow };
    postJson.mockResolvedValueOnce({ status: 'error', errorCode: 'bad_start_url', error: 'AWS didn’t recognise this start URL.' });
    await start();
    expect(await screen.findByRole('alert')).toHaveTextContent('AWS didn’t recognise this start URL.');
    expect(focusWindow).not.toHaveBeenCalled();
    cleanup();

    delete window.k8boardHost;
    postJson.mockResolvedValueOnce(waiting());
    getJson.mockResolvedValue({ status: 'done', converted: [] });
    await start();
    expect(await screen.findByText('Signed in to AWS', {}, SLOW)).toBeInTheDocument();
  });
});
