import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import UpdateDialogs from './UpdateDialogs';

vi.mock('../lib/api', async (orig) => {
  const actual = await orig();
  return { ...actual, getJson: vi.fn(), postJson: vi.fn() };
});
import { getJson, postJson, ApiError } from '../lib/api';

const SLOW = { timeout: 5000 };
const host = (detail) =>
  act(() => {
    window.dispatchEvent(new CustomEvent('kubepilot:host', { detail }));
  });
// /api/app/release-notes: the notes shipped with the app, for the running version.
const NOTES = {
  current: '1.4.0',
  releases: [
    {
      version: '1.4.0',
      date: '2026-10-01',
      current: true,
      highlights: [
        { title: 'Google GKE clusters', text: 'Add your GKE clusters from Preferences.' },
        { title: 'Faster lists', text: '' },
      ],
    },
    {
      version: '1.3.0',
      date: '2026-09-01',
      current: false,
      highlights: [{ title: 'A new Home screen', text: 'Home lists your clusters.' }],
    },
  ],
};
const STORE_URL = 'ms-windows-store://pdp/?productid=9N63V5DDVL9F';
// POST /api/app/update/check (and GET /api/app/update): what the backend answers.
const state = (phase, extra = {}) => ({
  state: { phase, currentVersion: '1.8.5', latest: null, managedBy: 'store', ...extra },
});

function setup() {
  render(<UpdateDialogs />);
  return userEvent.setup();
}

describe('Help → Show Release Notes', { timeout: 15000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'open').mockImplementation(() => null);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows what's new in each version, the running one first, and nothing leads out of the app", async () => {
    getJson.mockResolvedValue(NOTES);
    setup();
    await host({ type: 'show-release-notes' });
    const dlg = await screen.findByRole('dialog', { name: 'K8Board Release Notes' }, SLOW);
    const mine = await within(dlg).findByRole('region', { name: 'Version 1.4.0' }, SLOW);
    expect(within(mine).getByRole('heading', { name: 'Version 1.4.0' })).toBeInTheDocument();
    expect(mine).toHaveTextContent('This version');
    // A date without a time is that day everywhere (never the evening before).
    const day = new Date('2026-10-01').toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    });
    expect(mine).toHaveTextContent(day);
    expect(within(mine).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Google GKE clustersAdd your GKE clusters from Preferences.',
      'Faster lists',
    ]);
    const versions = [...dlg.querySelectorAll('section.release')].map((el) => el.getAttribute('aria-label'));
    expect(versions).toEqual(['Version 1.4.0', 'Version 1.3.0']);
    const older = within(dlg).getByRole('region', { name: 'Version 1.3.0' });
    expect(older).toHaveTextContent('A new Home screen');
    expect(older).not.toHaveTextContent('This version');
    expect(getJson).toHaveBeenCalledWith('/api/app/release-notes');
    // No link, no address, no "View on GitHub": the notes are the app's own.
    expect(within(dlg).queryAllByRole('link')).toEqual([]);
    expect(within(dlg).getAllByRole('button').map((b) => b.textContent)).not.toContain('View on GitHub');
    expect(dlg.innerHTML).not.toMatch(/github|https?:\/\//i);
    expect(window.open).not.toHaveBeenCalled();
  });

  it('a version with no notes of its own says so, and what was written is shown as text', async () => {
    getJson.mockResolvedValue({
      current: '1.5.0',
      releases: [
        {
          version: '1.4.0',
          date: null,
          current: false,
          highlights: [{ title: '<img src=x onerror="window.__pwned = 1">', text: '[docs](https://example.com)' }],
        },
      ],
    });
    setup();
    await host({ type: 'show-release-notes' });
    const dlg = await screen.findByRole('dialog', { name: 'K8Board Release Notes' }, SLOW);
    expect(await within(dlg).findByText(/You have version 1\.5\.0/, {}, SLOW)).toBeInTheDocument();
    expect(dlg).not.toHaveTextContent('This version');
    expect(dlg.querySelector('img')).toBeNull();
    expect(window.__pwned).toBeUndefined();
    expect(within(dlg).queryAllByRole('link')).toEqual([]);
    expect(dlg).toHaveTextContent('[docs](https://example.com)');
  });

  it('no notes at all: says so', async () => {
    getJson.mockResolvedValue({ current: '1.4.0', releases: [] });
    setup();
    await host({ type: 'show-release-notes' });
    const dlg = await screen.findByRole('dialog', { name: 'K8Board Release Notes' }, SLOW);
    expect(await within(dlg).findByText(/No release notes came with this version/, {}, SLOW)).toBeInTheDocument();
  });

  it('shows a friendly error when the notes cannot be loaded, and retries', async () => {
    getJson.mockRejectedValueOnce(
      new ApiError({ status: 500, code: 'error', message: 'The backend is not answering.' })
    );
    const user = setup();
    await host({ type: 'show-release-notes' });
    const alert = await screen.findByRole('alert', {}, SLOW);
    expect(alert).toHaveTextContent('Unable to load release notes');
    expect(alert).toHaveTextContent('The backend is not answering.');
    getJson.mockResolvedValueOnce(NOTES);
    await user.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(await screen.findByRole('heading', { name: 'Version 1.4.0' }, SLOW)).toBeInTheDocument();
    expect(getJson).toHaveBeenLastCalledWith('/api/app/release-notes');
  });
});

describe('Help → Check for Updates', { timeout: 15000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'open').mockImplementation(() => null);
    getJson.mockResolvedValue(state('idle'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  // Whatever the answer, K8Board itself offers nothing to download, install or restart.
  const installsNothing = (dlg) => {
    for (const name of ['Download and Install', 'Install and Restart', 'Restart Now', 'Later', 'View Release'])
      expect(within(dlg).queryByRole('button', { name })).toBeNull();
    expect(within(dlg).queryAllByRole('link')).toEqual([]);
    expect(dlg).not.toHaveTextContent(/GitHub|release page|Latest version|What's new/);
  };

  describe('Windows: the Microsoft Store is asked', () => {
    it('a newer version in the Store: both versions, and the way to the Store', async () => {
      let answer;
      postJson.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
      const user = setup();
      await host({ type: 'check-updates' });
      expect(await screen.findByText('Checking the Microsoft Store…', {}, SLOW)).toBeInTheDocument();
      await act(async () => {
        answer(state('available', { latest: { version: '1.8.6' } }));
      });
      const dlg = await screen.findByRole('dialog', { name: 'K8Board Update Available' }, SLOW);
      expect(dlg).toHaveTextContent('A new version of K8Board is available in the Microsoft Store.');
      expect(dlg).toHaveTextContent('Installed versionv1.8.5');
      expect(dlg).toHaveTextContent('Microsoft Store versionv1.8.6');
      expect(dlg).toHaveTextContent('The Microsoft Store installs it automatically');
      installsNothing(dlg);
      await user.click(within(dlg).getByRole('button', { name: 'Open Microsoft Store' }));
      expect(window.open).toHaveBeenCalledWith(STORE_URL, '_blank', 'noopener,noreferrer');
      expect(getJson).toHaveBeenCalledWith('/api/app/update');
      expect(postJson).toHaveBeenCalledTimes(1);
      expect(postJson).toHaveBeenCalledWith('/api/app/update/check', {});
    });

    it('the Store has nothing newer: up to date, and says who was asked', async () => {
      postJson.mockResolvedValue(state('up-to-date'));
      setup();
      await host({ type: 'check-updates' });
      const dlg = await screen.findByRole('dialog', { name: 'K8Board is up to date' }, SLOW);
      expect(dlg).toHaveTextContent('You are running the latest version: v1.8.5');
      expect(dlg).toHaveTextContent('Checked with the Microsoft Store.');
      installsNothing(dlg);
      expect(window.open).not.toHaveBeenCalled();
    });

    it("the Store can't be asked: no error, the way to K8Board's Store page instead", async () => {
      postJson.mockResolvedValue(state('store'));
      const user = setup();
      await host({ type: 'check-updates' });
      const dlg = await screen.findByRole('dialog', { name: 'Updates come from the Microsoft Store' }, SLOW);
      expect(dlg).toHaveTextContent('The Microsoft Store installs new versions automatically');
      expect(dlg).not.toHaveTextContent(/is up to date/);
      expect(screen.queryByRole('alert')).toBeNull();
      installsNothing(dlg);
      await user.click(within(dlg).getByRole('button', { name: 'Open Microsoft Store' }));
      expect(window.open).toHaveBeenCalledWith(STORE_URL, '_blank', 'noopener,noreferrer');
    });
  });

  it('a copy with no store behind it: says there is no update check, and asks nobody else', async () => {
    getJson.mockResolvedValue(state('idle', { managedBy: null }));
    postJson.mockResolvedValue(state('unavailable', { managedBy: null, currentVersion: '1.8.7' }));
    setup();
    await host({ type: 'check-updates' });
    const dlg = await screen.findByRole('dialog', { name: 'Check for Updates' }, SLOW);
    expect(await within(dlg).findByText(/doesn't check for updates/, {}, SLOW)).toBeInTheDocument();
    expect(dlg).toHaveTextContent('You have K8Board v1.8.7.');
    expect(dlg).not.toHaveTextContent(/Microsoft Store|up to date/);
    expect(within(dlg).queryByRole('button', { name: 'Open Microsoft Store' })).toBeNull();
    installsNothing(dlg);
    expect(window.open).not.toHaveBeenCalled();
  });

  it('the backend cannot be reached: "Unable to check for updates" with Try Again', async () => {
    postJson.mockRejectedValueOnce(
      new ApiError({ status: 503, code: 'error', message: 'The backend is not answering.' })
    );
    const user = setup();
    await host({ type: 'check-updates' });
    const dlg = await screen.findByRole('dialog', { name: 'Unable to check for updates' }, SLOW);
    expect(within(dlg).getByRole('alert')).toHaveTextContent('The backend is not answering.');
    postJson.mockResolvedValueOnce(state('up-to-date'));
    await user.click(within(dlg).getByRole('button', { name: 'Try Again' }));
    expect(await screen.findByRole('dialog', { name: 'K8Board is up to date' }, SLOW)).toBeInTheDocument();
    expect(postJson).toHaveBeenCalledTimes(2);
  });

  it('an update result from an older desktop shell is ignored: nothing opens', async () => {
    setup();
    await host({ type: 'update-result', status: 'failed', version: '1.4.0', from: '1.3.0' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(postJson).not.toHaveBeenCalled();
  });
});
