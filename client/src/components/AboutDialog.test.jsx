import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, fireEvent, within } from '@testing-library/react';
import AboutDialog, { openAbout, ABOUT_LINKS } from './AboutDialog';

const hostEvent = (type) => act(() => { window.dispatchEvent(new CustomEvent('kubepilot:host', { detail: { type } })); });

describe('AboutDialog (Help → About K8Board)', () => {
  afterEach(() => { delete window.k8boardHost; vi.restoreAllMocks(); });

  it('opens from the Help menu with the name, version, links and licences; Close closes it', () => {
    render(<AboutDialog />);
    expect(screen.queryByRole('dialog')).toBeNull();
    hostEvent('show-release-notes'); // other Help items don't open it
    expect(screen.queryByRole('dialog')).toBeNull();

    hostEvent('show-about');
    const dlg = screen.getByRole('dialog', { name: 'About K8Board' });
    expect(dlg).toHaveTextContent(/K8Board/);
    if (typeof __APP_VERSION__ !== 'undefined') expect(dlg).toHaveTextContent(`Version ${__APP_VERSION__}`);
    expect(dlg).toHaveTextContent('MIT License');
    expect(dlg).toHaveTextContent('SIL Open Font License');
    const links = within(screen.getByRole('navigation', { name: 'K8Board links' })).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(ABOUT_LINKS.map((l) => l.href));
    for (const a of links) expect(a.getAttribute('href')).toMatch(/^https:\/\/k8dashboard\.in/);
    expect(dlg.innerHTML).not.toMatch(/github/i);
    // The web build has no updater: no Check for Updates.
    expect(within(dlg).queryByRole('button', { name: /Check for Updates/ })).toBeNull();

    fireEvent.click(within(dlg).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('links open in the system browser', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<AboutDialog />);
    act(() => openAbout());
    fireEvent.click(screen.getByRole('link', { name: 'Privacy' }));
    expect(open).toHaveBeenCalledWith('https://k8dashboard.in/privacy', '_blank', 'noopener,noreferrer');
  });

  it('desktop app: Check for Updates closes About and starts the Help menu check', () => {
    window.k8boardHost = {};
    const seen = [];
    const onHost = (e) => seen.push(e.detail.type);
    window.addEventListener('kubepilot:host', onHost);
    render(<AboutDialog />);
    act(() => openAbout());
    fireEvent.click(screen.getByRole('button', { name: /Check for Updates/ }));
    window.removeEventListener('kubepilot:host', onHost);
    expect(seen).toEqual(['check-updates']);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
