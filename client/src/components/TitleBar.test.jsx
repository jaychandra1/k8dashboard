import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TitleBar, { hasTitleBar, toMenuItems, toHex } from './TitleBar';

// What the desktop shell describes (electron/window-chrome.cjs describeMenu).
const MENU = [
  { id: '0', type: 'submenu', label: 'View', enabled: true, submenu: [
    { id: '0.0', type: 'normal', label: 'Reload', enabled: true, accelerator: 'Ctrl+R' },
    { id: '0.1', type: 'normal', label: 'Force Reload', enabled: true, accelerator: 'Ctrl+Shift+R' },
    { id: '0.2', type: 'separator' },
    { id: '0.3', type: 'normal', label: 'Toggle Full Screen', enabled: true, accelerator: 'F11' },
  ] },
  { id: '1', type: 'submenu', label: 'Clusters', enabled: true, submenu: [
    { id: '1.0', type: 'normal', label: 'Switch Cluster…', enabled: true },
  ] },
  { id: '2', type: 'submenu', label: 'Help', enabled: true, submenu: [
    { id: '2.0', type: 'normal', label: 'Show Release Notes', enabled: true },
    { id: '2.1', type: 'normal', label: 'Open Logs Folder', enabled: false },
  ] },
];
const SLOW = { timeout: 5000 };
const install = (over = {}) => {
  window.k8boardHost = { titleBar: true, menu: vi.fn(async () => MENU), menuClick: vi.fn(async () => true), chrome: vi.fn(), ...over };
  return window.k8boardHost;
};

describe('TitleBar (the desktop app on Windows draws its own title bar)', () => {
  afterEach(() => { delete window.k8boardHost; document.documentElement.removeAttribute('data-theme'); });

  it('is only there where the desktop shell says so', () => {
    expect(hasTitleBar()).toBe(false);
    window.k8boardHost = { reportPdf: () => {} };
    expect(hasTitleBar()).toBe(false);
    install();
    expect(hasTitleBar()).toBe(true);
  });

  it('shows the icon, the application menus and the window title in one bar', async () => {
    install();
    const { container } = render(<TitleBar title="Pods · demo — K8Board" />);
    const bar = await screen.findByRole('menubar', { name: 'Application menu' }, SLOW);
    await waitFor(() => expect(within(bar).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['View', 'Clusters', 'Help']));
    expect(container.querySelector('img.titlebar-icon')).toHaveAttribute('src', '/logo-mark.png');
    expect(container.querySelector('.titlebar-title')).toHaveTextContent('Pods · demo — K8Board');
    // Closed until asked: no menu is open, and nothing has been chosen.
    expect(screen.queryByRole('menu')).toBeNull();
    expect(window.k8boardHost.menuClick).not.toHaveBeenCalled();
  });

  it('a menu opens under its name; choosing an item tells the shell which one, by its id', async () => {
    const host = install();
    const user = userEvent.setup();
    render(<TitleBar title="K8Board" />);
    const view = await screen.findByRole('menuitem', { name: 'View' }, SLOW);
    await user.click(view);
    expect(view).toHaveAttribute('aria-expanded', 'true');
    const menu = await screen.findByRole('menu', { name: 'View' }, SLOW);
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['ReloadCtrl+R', 'Force ReloadCtrl+Shift+R', 'Toggle Full ScreenF11']);
    await user.click(within(menu).getByRole('menuitem', { name: /Force Reload/ }));
    expect(host.menuClick).toHaveBeenCalledTimes(1);
    expect(host.menuClick).toHaveBeenCalledWith('0.1');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('a disabled item cannot be chosen; clicking the open menu\'s name closes it', async () => {
    const host = install();
    const user = userEvent.setup();
    render(<TitleBar title="K8Board" />);
    const help = await screen.findByRole('menuitem', { name: 'Help' }, SLOW);
    await user.click(help);
    const menu = await screen.findByRole('menu', { name: 'Help' }, SLOW);
    const logs = within(menu).getByRole('menuitem', { name: 'Open Logs Folder' });
    expect(logs).toHaveAttribute('aria-disabled', 'true');
    await user.click(logs);
    expect(host.menuClick).not.toHaveBeenCalled();
    await user.click(help);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('with one menu open, moving along the bar opens the next', async () => {
    install();
    const user = userEvent.setup();
    render(<TitleBar title="K8Board" />);
    await user.click(await screen.findByRole('menuitem', { name: 'View' }, SLOW));
    await screen.findByRole('menu', { name: 'View' }, SLOW);
    await user.hover(screen.getByRole('menuitem', { name: 'Clusters' }));
    expect(await screen.findByRole('menu', { name: 'Clusters' }, SLOW)).toBeInTheDocument();
    expect(screen.queryByRole('menu', { name: 'View' })).toBeNull();
  });

  it('keyboard: arrows move along the bar, Down opens the menu', async () => {
    install();
    const user = userEvent.setup();
    render(<TitleBar title="K8Board" />);
    const view = await screen.findByRole('menuitem', { name: 'View' }, SLOW);
    view.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('menuitem', { name: 'Clusters' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('menuitem', { name: 'Help' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(await screen.findByRole('menu', { name: 'Help' }, SLOW)).toBeInTheDocument();
  });

  it('tells the shell its colours for the caption buttons, again when the theme changes', async () => {
    const host = install();
    const style = document.createElement('style');
    style.textContent = '.titlebar{background-color:rgb(11, 12, 14);color:rgb(230, 230, 234)} [data-theme="light"] .titlebar{background-color:rgb(255, 255, 255);color:rgb(31, 35, 40)}';
    document.head.appendChild(style);
    try {
      render(<TitleBar title="K8Board" />);
      await waitFor(() => expect(host.chrome).toHaveBeenCalledWith('#0b0c0e', '#e6e6ea'));
      await act(async () => { document.documentElement.setAttribute('data-theme', 'light'); await new Promise((r) => setTimeout(r, 20)); });
      await waitFor(() => expect(host.chrome).toHaveBeenLastCalledWith('#ffffff', '#1f2328'));
    } finally {
      style.remove();
    }
  });

  it('a shell that answers nothing, or fails, leaves an empty bar rather than an error', async () => {
    install({ menu: vi.fn(async () => { throw new Error('gone'); }) });
    render(<TitleBar title="K8Board" />);
    await waitFor(() => expect(window.k8boardHost.menu).toHaveBeenCalled());
    expect(screen.getByRole('menubar', { name: 'Application menu' })).toBeEmptyDOMElement();
  });
});

describe('TitleBar helpers', () => {
  it('toMenuItems: separators, shortcuts, disabled, checked and nested menus', () => {
    const choose = vi.fn();
    const items = toMenuItems([
      { id: '0', type: 'normal', label: 'Reload', enabled: true, accelerator: 'Ctrl+R' },
      { id: '1', type: 'separator' },
      { id: '2', type: 'checkbox', label: 'Wrap', enabled: false, checked: true },
      { id: '3', type: 'submenu', label: 'More', enabled: true, submenu: [{ id: '3.0', type: 'normal', label: 'Deep', enabled: true }] },
    ], choose);
    expect(items.map((i) => (i.divider ? '—' : `${i.label}|${i.hint || ''}|${!!i.disabled}|${i.checked ?? ''}`))).toEqual(['Reload|Ctrl+R|false|', '—', 'Wrap||true|true', 'More||false|']);
    items[0].onSelect();
    items[3].children[0].onSelect();
    expect(choose.mock.calls).toEqual([['0'], ['3.0']]);
    expect(items[3].onSelect).toBeUndefined();
    expect(toMenuItems(undefined, choose)).toEqual([]);
  });

  it('toHex reads the colours a browser reports', () => {
    expect(toHex('rgb(11, 12, 14)')).toBe('#0b0c0e');
    expect(toHex('rgba(255, 255, 255, 0.5)')).toBe('#ffffff');
    expect(toHex('rgb(0 128 255)')).toBe('#0080ff');
    for (const bad of ['', 'transparent', 'red', null, undefined]) expect(toHex(bad)).toBeNull();
  });
});
