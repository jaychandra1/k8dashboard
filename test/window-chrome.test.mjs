// The app-drawn title bar on Windows (electron/window-chrome.cjs): which
// platforms have it, how the application menu is described to the page, and
// that the page can only choose items that are really in it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT_DIR } from '../lib/paths.mjs';

const require = createRequire(import.meta.url);
const chrome = require('../electron/window-chrome.cjs');

// A stand-in for Electron's Menu: items with label/type/enabled/visible/submenu/click.
const item = (o) => ({ type: 'normal', enabled: true, visible: true, ...o });
const sep = () => ({ type: 'separator', enabled: true, visible: true });
function menu(clicked = []) {
  const click = (name) => (ev, win, wc) => clicked.push([name, win?.name, wc?.name]);
  return {
    items: [
      item({ label: 'View', submenu: { items: [
        item({ label: 'Reload', role: 'reload', getDefaultRoleAccelerator: () => 'CommandOrControl+R', click: click('reload') }),
        item({ label: 'Force Reload', getDefaultRoleAccelerator: () => 'Shift+CmdOrCtrl+R', click: click('forceReload') }),
        sep(),
        item({ label: 'Zoom &In', accelerator: 'CommandOrControl+Plus', click: click('zoomIn') }),
        item({ label: 'Hidden', visible: false, click: click('hidden') }),
      ] } }),
      item({ label: 'Help', submenu: { items: [
        item({ label: 'Open Logs Folder', enabled: false, click: click('logs') }),
        item({ label: 'Wrap', type: 'checkbox', checked: true, click: click('wrap') }),
        item({ label: 'More', submenu: { items: [item({ label: 'Deep', click: click('deep') })] } }),
      ] } }),
    ],
  };
}

describe('which windows get the app-drawn title bar', () => {
  test('Windows: hidden title bar with the caption buttons drawn over it; macOS and Linux as before', () => {
    assert.equal(chrome.usesTitleBar('win32'), true);
    assert.equal(chrome.usesTitleBar('darwin'), false);
    assert.equal(chrome.usesTitleBar('linux'), false);
    assert.deepEqual(chrome.titleBarOptions('win32'), {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#000000', symbolColor: '#e2e8f0', height: 36 },
    });
    assert.deepEqual(chrome.titleBarOptions('darwin'), { titleBarStyle: 'hiddenInset' });
    assert.deepEqual(chrome.titleBarOptions('linux'), { titleBarStyle: 'default' });
  });

  test('the bar is as tall in the page as the caption buttons are', () => {
    const css = fs.readFileSync(path.join(ROOT_DIR, 'client', 'src', 'App.css'), 'utf8');
    assert.match(css, new RegExp(`\\.is-win \\{ --titlebar-h: ${chrome.TITLE_BAR_HEIGHT}px; \\}`));
  });
});

describe('the application menu, described for the page', () => {
  test('labels, shortcuts as Windows writes them, states and nesting; hidden items left out', () => {
    const d = chrome.describeMenu(menu());
    assert.deepEqual(d.map((m) => [m.id, m.label, m.type]), [['0', 'View', 'submenu'], ['1', 'Help', 'submenu']]);
    assert.deepEqual(d[0].submenu, [
      { id: '0.0', type: 'normal', label: 'Reload', enabled: true, accelerator: 'Ctrl+R' },
      { id: '0.1', type: 'normal', label: 'Force Reload', enabled: true, accelerator: 'Ctrl+Shift+R' },
      { id: '0.2', type: 'separator' },
      { id: '0.3', type: 'normal', label: 'Zoom In', enabled: true, accelerator: 'Ctrl++' },
    ]);
    assert.deepEqual(d[1].submenu[0], { id: '1.0', type: 'normal', label: 'Open Logs Folder', enabled: false });
    assert.deepEqual(d[1].submenu[1], { id: '1.1', type: 'checkbox', label: 'Wrap', enabled: true, checked: true });
    assert.deepEqual(d[1].submenu[2].submenu, [{ id: '1.2.0', type: 'normal', label: 'Deep', enabled: true }]);
    // Plain data only: it crosses to the page.
    assert.deepEqual(JSON.parse(JSON.stringify(d)), d);
    assert.deepEqual(chrome.describeMenu(null), []);
  });

  test('shortcut text', () => {
    assert.equal(chrome.acceleratorText('CommandOrControl+Shift+R'), 'Ctrl+Shift+R');
    assert.equal(chrome.acceleratorText('Alt+F4'), 'Alt+F4');
    assert.equal(chrome.acceleratorText('Shift+CmdOrCtrl+R'), 'Ctrl+Shift+R', 'modifiers in the order Windows writes them');
    assert.equal(chrome.acceleratorText('Shift+Alt+Control+K'), 'Ctrl+Alt+Shift+K');
    assert.equal(chrome.acceleratorText('F11'), 'F11');
    assert.equal(chrome.acceleratorText('CmdOrCtrl+0'), 'Ctrl+0');
    assert.equal(chrome.acceleratorText(undefined), '');
  });
});

describe('choosing an item from the page', () => {
  const win = { name: 'window', webContents: { name: 'contents' } };

  test('an item that is there, shown and enabled is clicked as the native menu would', () => {
    const clicked = [];
    const m = menu(clicked);
    assert.equal(chrome.clickMenuItem(m, '0.1', win), true);
    assert.equal(chrome.clickMenuItem(m, '1.2.0', win), true);
    assert.deepEqual(clicked, [['forceReload', 'window', 'contents'], ['deep', 'window', 'contents']]);
  });

  test('anything else is refused and nothing runs', () => {
    const clicked = [];
    const m = menu(clicked);
    for (const id of [
      '0',        // a menu, not an item
      '0.2',      // a separator
      '0.4',      // hidden
      '1.0',      // disabled
      '1.2',      // a submenu
      '0.9', '7', '1.2.5',           // not there
      '', '0.', '.0', '0..1', '-1', '0.1.2.3.4', '999', 'constructor', '__proto__', '0.items', null, undefined, 3, {},
    ]) assert.equal(chrome.clickMenuItem(m, id, win), false, String(id));
    assert.deepEqual(clicked, []);
    assert.equal(chrome.clickMenuItem(null, '0.0', win), false);
  });
});

describe('the page side of the title bar', () => {
  // A stand-in ipcMain that records what was registered.
  function setup({ platform = 'win32', allowed = true, window } = {}) {
    const handlers = {};
    const listeners = {};
    const clicked = [];
    const overlays = [];
    const win = window === undefined ? { isDestroyed: () => false, webContents: {}, setTitleBarOverlay: (o) => overlays.push(o) } : window;
    chrome.registerWindowChrome({
      ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; }, on: (ch, fn) => { listeners[ch] = fn; } },
      Menu: { getApplicationMenu: () => menu(clicked) },
      getWindow: () => win,
      isAllowedSender: () => allowed,
      platform,
    });
    return { handlers, listeners, clicked, overlays };
  }

  test("only the app's own page is answered, and only where the bar exists", () => {
    const ok = setup();
    assert.equal(ok.handlers[chrome.MENU_CHANNEL]({}).length, 2);
    assert.equal(ok.handlers[chrome.MENU_CLICK_CHANNEL]({}, '0.0'), true);
    assert.deepEqual(ok.clicked.map((c) => c[0]), ['reload']);

    for (const other of [setup({ allowed: false }), setup({ platform: 'linux' }), setup({ platform: 'darwin' })]) {
      assert.deepEqual(other.handlers[chrome.MENU_CHANNEL]({}), []);
      assert.equal(other.handlers[chrome.MENU_CLICK_CHANNEL]({}, '0.0'), false);
      other.listeners[chrome.CHROME_CHANNEL]({}, { color: '#ffffff', symbolColor: '#000000' });
      assert.deepEqual(other.clicked, []);
      assert.deepEqual(other.overlays, []);
    }
  });

  test('the caption buttons take the two colours the page names, and nothing that is not a colour', () => {
    const { listeners, overlays } = setup();
    const tell = listeners[chrome.CHROME_CHANNEL];
    tell({}, { color: '#FFFFFF', symbolColor: '#1f2328' });
    assert.deepEqual(overlays, [{ color: '#ffffff', symbolColor: '#1f2328', height: 36 }]);
    for (const bad of [null, {}, { color: '#fff', symbolColor: '#000000' }, { color: 'red', symbolColor: '#000000' }, { color: '#ffffff' }, { color: '#ffffff', symbolColor: 'url(x)' }, { color: 7, symbolColor: 8 }]) tell({}, bad);
    assert.equal(overlays.length, 1);
    assert.equal(chrome.overlayColors({ color: '#0B0C0E', symbolColor: '#E6E6EA' }).color, '#0b0c0e');
  });

  test('a window that is gone is left alone', () => {
    const gone = setup({ window: { isDestroyed: () => true, setTitleBarOverlay: () => { throw new Error('destroyed'); } } });
    assert.doesNotThrow(() => gone.listeners[chrome.CHROME_CHANNEL]({}, { color: '#ffffff', symbolColor: '#000000' }));
    const none = setup({ window: null });
    assert.doesNotThrow(() => none.listeners[chrome.CHROME_CHANNEL]({}, { color: '#ffffff', symbolColor: '#000000' }));
  });
});

describe('the desktop shell uses it', () => {
  const main = fs.readFileSync(path.join(ROOT_DIR, 'electron', 'main.cjs'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT_DIR, 'electron', 'preload.cjs'), 'utf8');

  test('the window takes its title bar from it, hides the native menu row there, and answers the page', () => {
    assert.match(main, /\.\.\.titleBarOptions\(\),/);
    assert.match(main, /if \(usesTitleBar\(\)\) \{\s*mainWindow\.setAutoHideMenuBar\(false\);\s*mainWindow\.setMenuBarVisibility\(false\);/);
    assert.match(main, /registerWindowChrome\(\{ ipcMain, Menu, getWindow: \(\) => mainWindow, isAllowedSender: isAppPage \}\);/);
    // The application menu is still set: its shortcuts (Ctrl+R, Ctrl+Shift+R, F11…) keep working.
    assert.match(main, /Menu\.setApplicationMenu\(buildMenu\(\)\);/);
    assert.match(main, /'is-electron', 'is-win'/);
  });

  test('the Clusters menu lists no clusters and knows nothing of pins: it opens the Switch cluster window', () => {
    assert.match(main, /\{ label: 'Switch Cluster…', click: \(\) => notifyRenderer\(\{ type: 'open-contexts' \}\) \},/);
    assert.doesNotMatch(main, /pins|pinned|settings\/pins|refreshClustersMenu|switchClusterFromMenu/i);
  });

  test('the preload exposes the bar and nothing wider', () => {
    for (const channel of [chrome.MENU_CHANNEL, chrome.MENU_CLICK_CHANNEL, chrome.CHROME_CHANNEL]) assert.ok(preload.includes(`'${channel}'`), channel);
    const exposed = [...preload.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]);
    assert.deepEqual(exposed, ['reportPdf', 'updates', 'titleBar', 'menu', 'menuClick', 'chrome']);
    assert.doesNotMatch(preload, /require\('(fs|child_process|path|os)'\)|ipcRenderer\.(on|sendSync)\b/);
  });
});
