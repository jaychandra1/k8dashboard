import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import UpdateDialogs, { fmtBytes } from './UpdateDialogs';
import { ToastProvider } from './Toast';

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
const LATEST = {
  version: '1.4.0',
  tag: 'v1.4.0',
  name: 'KubePilot 1.4.0',
  publishedAt: '2026-10-01T10:00:00Z',
  htmlUrl: 'https://github.com/jaychandra1/KubePilot/releases/tag/v1.4.0',
};
const state = (phase, extra = {}) => ({
  state: {
    phase,
    currentVersion: '1.3.0',
    latest: LATEST,
    canInstall: true,
    installUnavailable: null,
    installMode: 'on-restart',
    asset: { name: 'KubePilot-windows.exe', size: 49_388_749 },
    progress: null,
    error: null,
    dryRun: false,
    ...extra,
  },
});

function setup() {
  render(
    <ToastProvider>
      <UpdateDialogs />
    </ToastProvider>
  );
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

  it('loads the latest release, renders its Markdown safely, and opens it on GitHub', async () => {
    getJson.mockResolvedValue({
      release: {
        ...LATEST,
        body: '# KubePilot 1.4.0\n\n## Added\n- **Help menu**\n\n<script>window.__pwned = 1</script>\n[docs](javascript:alert(1))',
      },
    });
    const user = setup();
    await host({ type: 'show-release-notes' });
    const dlg = await screen.findByRole('dialog', { name: 'KubePilot Release Notes' }, SLOW);
    expect(await within(dlg).findByText('Version 1.4.0', {}, SLOW)).toBeInTheDocument();
    const day = new Date('2026-10-01T10:00:00Z').toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    expect(within(dlg).getByText(/^Released: /)).toHaveTextContent(`Released: ${day}`);
    expect(within(dlg).getByRole('heading', { name: 'Added' })).toBeInTheDocument();
    expect(within(dlg).getByText('Help menu').tagName).toBe('STRONG');
    expect(dlg.querySelector('script')).toBeNull();
    expect(window.__pwned).toBeUndefined();
    expect(within(dlg).queryByRole('link', { name: 'docs' })).toBeNull(); // unsafe href → plain text
    expect(getJson).toHaveBeenCalledWith('/api/app/release-notes', { params: undefined });
    await user.click(within(dlg).getByRole('button', { name: 'View on GitHub' }));
    expect(window.open).toHaveBeenCalledWith(LATEST.htmlUrl, '_blank', 'noopener,noreferrer');
  });

  it('shows a friendly error when GitHub cannot be reached, and retries', async () => {
    getJson.mockRejectedValueOnce(
      new ApiError({
        status: 503,
        code: 'offline',
        message: 'KubePilot could not connect to GitHub. Please check your network connection.',
      })
    );
    const user = setup();
    await host({ type: 'show-release-notes' });
    const alert = await screen.findByRole('alert', {}, SLOW);
    expect(alert).toHaveTextContent('Unable to load release notes');
    expect(alert).toHaveTextContent('could not connect to GitHub');
    getJson.mockResolvedValueOnce({ release: { ...LATEST, body: 'ok' } });
    await user.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(await screen.findByText('Version 1.4.0', {}, SLOW)).toBeInTheDocument();
    expect(getJson).toHaveBeenLastCalledWith('/api/app/release-notes', { params: { fresh: '1' } });
  });
});

describe('Help → Check for Updates', { timeout: 15000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'open').mockImplementation(() => null);
    getJson.mockResolvedValue(state('idle', { latest: null }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('up to date: says so, downloads nothing', async () => {
    postJson.mockResolvedValue(state('up-to-date', { latest: null }));
    setup();
    await host({ type: 'check-updates' });
    const dlg = await screen.findByRole('dialog', { name: 'KubePilot is up to date' }, SLOW);
    expect(dlg).toHaveTextContent('You are running the latest version: v1.3.0');
    expect(postJson).toHaveBeenCalledTimes(1);
    expect(postJson).toHaveBeenCalledWith('/api/app/update/check', {});
  });

  it('update available → nothing happens until "Download and Install"; then progress and Cancel', async () => {
    postJson.mockResolvedValueOnce(state('available'));
    const user = setup();
    await host({ type: 'check-updates' });
    const dlg = await screen.findByRole('dialog', { name: 'KubePilot Update Available' }, SLOW);
    expect(dlg).toHaveTextContent('A new version of KubePilot is available.');
    expect(dlg).toHaveTextContent('Installed versionv1.3.0');
    expect(dlg).toHaveTextContent('Latest versionv1.4.0');
    expect(postJson).toHaveBeenCalledTimes(1);

    postJson.mockResolvedValueOnce(
      state('downloading', { progress: { received: 35_861_094, total: 49_388_749 } })
    );
    getJson.mockResolvedValue(
      state('downloading', { progress: { received: 35_861_094, total: 49_388_749 } })
    );
    await user.click(within(dlg).getByRole('button', { name: 'Download and Install' }));
    expect(postJson).toHaveBeenLastCalledWith('/api/app/update/download', {});
    const updating = await screen.findByRole('dialog', { name: 'Updating KubePilot' }, SLOW);
    expect(updating).toHaveTextContent('Downloading KubePilot v1.4.0…');
    expect(within(updating).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '72');
    expect(updating).toHaveTextContent('34.2 MB / 47.1 MB');

    postJson.mockResolvedValueOnce(state('cancelled'));
    await user.click(within(updating).getByRole('button', { name: 'Cancel' }));
    expect(postJson).toHaveBeenLastCalledWith('/api/app/update/cancel', {});
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), SLOW);
    expect(await screen.findByText('The update download was cancelled.', {}, SLOW)).toBeInTheDocument();
  });

  it('verification failure: explains it, and offers no way to install anyway', async () => {
    postJson.mockResolvedValue(
      state('failed', {
        error: {
          code: 'verification_failed',
          stage: 'verify',
          message: 'The downloaded KubePilot update could not be verified and will not be installed.',
        },
      })
    );
    setup();
    await host({ type: 'check-updates' });
    const dlg = await screen.findByRole('dialog', { name: 'Update verification failed' }, SLOW);
    expect(dlg).toHaveTextContent('could not be verified and will not be installed');
    // Only Close (the footer button and the header X) — no Try Again / Install anyway.
    expect(
      within(dlg)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label') || b.textContent)
    ).toEqual(['Close dialog', 'Close']);
  });

  it('no compatible installer: names the platform and links the release', async () => {
    postJson.mockResolvedValue(
      state('failed', {
        error: {
          code: 'no_asset_for_arch',
          stage: 'select',
          message: 'KubePilot v1.4.0 is available, but an installer for Windows ARM64 could not be found.',
        },
      })
    );
    const user = setup();
    await host({ type: 'check-updates' });
    const dlg = await screen.findByRole('dialog', { name: 'No compatible installer' }, SLOW);
    expect(dlg).toHaveTextContent('Windows ARM64');
    await user.click(within(dlg).getByRole('button', { name: 'View Release' }));
    expect(window.open).toHaveBeenCalledWith(LATEST.htmlUrl, '_blank', 'noopener,noreferrer');
  });

  it('GitHub unavailable: "Unable to check for updates" with Try Again', async () => {
    postJson.mockResolvedValueOnce(
      state('failed', {
        latest: null,
        error: {
          code: 'offline',
          stage: 'check',
          message: 'KubePilot could not connect to GitHub. Please check your network connection.',
        },
      })
    );
    const user = setup();
    await host({ type: 'check-updates' });
    const dlg = await screen.findByRole('dialog', { name: 'Unable to check for updates' }, SLOW);
    expect(dlg).toHaveTextContent('Please check your network connection.');
    postJson.mockResolvedValueOnce(state('up-to-date', { latest: null }));
    await user.click(within(dlg).getByRole('button', { name: 'Try Again' }));
    expect(await screen.findByRole('dialog', { name: 'KubePilot is up to date' }, SLOW)).toBeInTheDocument();
    expect(postJson).toHaveBeenCalledTimes(2);
  });

  it('install failure keeps the old installation and offers Try Again', async () => {
    postJson.mockResolvedValue(
      state('failed', {
        error: {
          code: 'install_failed',
          stage: 'install',
          message:
            'The update could not be installed. Your existing KubePilot installation has not been modified.',
        },
      })
    );
    setup();
    await host({ type: 'check-updates' });
    const dlg = await screen.findByRole('dialog', { name: 'Update failed' }, SLOW);
    expect(dlg).toHaveTextContent('has not been modified');
    expect(within(dlg).getByRole('button', { name: 'Try Again' })).toBeInTheDocument();
  });

  it('Windows: verified update → "Later" schedules it for quit', async () => {
    getJson.mockResolvedValue(state('ready'));
    const user = setup();
    await host({ type: 'check-updates' });
    const dlg = await screen.findByRole('dialog', { name: 'Ready to Install' }, SLOW);
    expect(postJson).not.toHaveBeenCalled(); // resumed, not re-checked
    postJson.mockResolvedValueOnce(state('scheduled'));
    await user.click(within(dlg).getByRole('button', { name: 'Later' }));
    expect(postJson).toHaveBeenCalledWith('/api/app/update/install', { when: 'on-quit' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), SLOW);
    expect(
      await screen.findByText('KubePilot v1.4.0 will be installed when you quit KubePilot.', {}, SLOW)
    ).toBeInTheDocument();
  });

  it('macOS / Linux: installed → "Restart Now" asks the app to relaunch', async () => {
    getJson.mockResolvedValue(state('installed', { installMode: 'in-place' }));
    const user = setup();
    await host({ type: 'check-updates' });
    const dlg = await screen.findByRole('dialog', { name: 'Update Installed' }, SLOW);
    expect(dlg).toHaveTextContent('KubePilot v1.4.0 has been installed successfully.');
    expect(dlg).toHaveTextContent('Restart KubePilot to complete the update.');
    postJson.mockResolvedValueOnce(state('restarting', { installMode: 'in-place' }));
    await user.click(within(dlg).getByRole('button', { name: 'Restart Now' }));
    expect(postJson).toHaveBeenCalledWith('/api/app/update/restart', {});
    expect(await screen.findByText('Restarting KubePilot…', {}, SLOW)).toBeInTheDocument();
  });

  it('a copy that cannot update itself offers the release page instead of downloading', async () => {
    postJson.mockResolvedValue(
      state('available', {
        canInstall: false,
        installUnavailable: "This is a development build of KubePilot, so it can't install updates.",
      })
    );
    setup();
    await host({ type: 'check-updates' });
    const dlg = await screen.findByRole('dialog', { name: 'KubePilot Update Available' }, SLOW);
    expect(dlg).toHaveTextContent('development build');
    expect(within(dlg).queryByRole('button', { name: 'Download and Install' })).toBeNull();
    expect(within(dlg).getByRole('button', { name: 'View Release' })).toBeInTheDocument();
  });

  it('after a Windows update that did not complete, says the old version is untouched', async () => {
    setup();
    await host({ type: 'update-result', status: 'failed', version: '1.4.0', from: '1.3.0' });
    const dlg = await screen.findByRole('dialog', { name: 'Update failed' }, SLOW);
    expect(dlg).toHaveTextContent(
      'The update to KubePilot v1.4.0 did not complete. Your existing KubePilot installation (v1.3.0) has not been modified.'
    );
  });
});

describe('fmtBytes', () => {
  it('formats sizes', () => {
    expect(fmtBytes(512 * 1024)).toBe('512 KB');
    expect(fmtBytes(49_388_749)).toBe('47.1 MB');
    expect(fmtBytes(undefined)).toBe('—');
  });
});
