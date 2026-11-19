// The window's title bar on Windows: the app draws it (its icon, the menus,
// the window title) and Windows draws the caption buttons over its right end
// (titleBarOverlay). One slim bar takes the place of the native title bar and
// the menu row under it.
//
// The menus are the application menu's own (electron/main.cjs buildMenu): the
// page asks for a description of it and says which item was chosen — nothing
// else crosses, and an item does exactly what it does in the native menu
// (macOS and Linux keep that native menu). The page also names the bar's two
// colours so the caption buttons match the theme.
'use strict';

const MENU_CHANNEL = 'k8board:menu';
const MENU_CLICK_CHANNEL = 'k8board:menu-click';
const CHROME_CHANNEL = 'k8board:chrome';
/** The page asks for the window to come to the front (every platform). */
const FOCUS_CHANNEL = 'k8board:focus';
/** Height of the bar in px; client/src/App.css `.titlebar` uses the same. */
const TITLE_BAR_HEIGHT = 36;
const COLOR = /^#[0-9a-f]{6}$/i;
const ITEM_ID = /^\d{1,2}(\.\d{1,2}){0,3}$/;
// The bar before the page has said anything: the splash screen's black.
const FIRST_OVERLAY = Object.freeze({ color: '#000000', symbolColor: '#e2e8f0' });

/** Does this platform get the app-drawn title bar? */
const usesTitleBar = (platform = process.platform) => platform === 'win32';

/** The BrowserWindow options that decide the title bar. */
function titleBarOptions(platform = process.platform) {
  // macOS: the traffic lights float over the content; the menu is the system's.
  if (platform === 'darwin') return { titleBarStyle: 'hiddenInset' };
  if (usesTitleBar(platform))
    return { titleBarStyle: 'hidden', titleBarOverlay: { ...FIRST_OVERLAY, height: TITLE_BAR_HEIGHT } };
  return { titleBarStyle: 'default' };
}

/** "CommandOrControl+Shift+R" → "Ctrl+Shift+R" (what a Windows menu shows). */
function acceleratorText(accelerator) {
  if (typeof accelerator !== 'string' || !accelerator) return '';
  const parts = accelerator.split('+').map((part) => {
    const p = part.trim();
    if (/^(CommandOrControl|CmdOrCtrl|Control|Ctrl|Command|Cmd)$/i.test(p)) return 'Ctrl';
    if (/^(Alt|Option)$/i.test(p)) return 'Alt';
    if (/^Shift$/i.test(p)) return 'Shift';
    if (/^Plus$/i.test(p)) return '+';
    return p.length === 1 ? p.toUpperCase() : p;
  });
  // Modifiers in the order Windows writes them, then the key.
  const ORDER = ['Ctrl', 'Alt', 'Shift'];
  const modifiers = ORDER.filter((m) => parts.includes(m));
  return [...modifiers, ...parts.filter((p) => !ORDER.includes(p))].join('+');
}

/**
 * A menu as plain data for the page:
 *   [{ id, label, type: 'normal'|'separator'|'submenu'|'checkbox'|'radio', enabled, checked, accelerator, submenu }]
 * `id` is the item's position ("3.1": the second item of the fourth menu).
 */
function describeMenu(menu, prefix = '') {
  const items = menu && Array.isArray(menu.items) ? menu.items : [];
  const out = [];
  items.forEach((item, i) => {
    if (!item || item.visible === false) return;
    const id = prefix ? `${prefix}.${i}` : String(i);
    if (item.type === 'separator') return void out.push({ id, type: 'separator' });
    const entry = {
      id,
      type: item.submenu ? 'submenu' : item.type || 'normal',
      label: String(item.label || '').replace(/&(.)/g, '$1'),
      enabled: item.enabled !== false,
    };
    if (item.type === 'checkbox' || item.type === 'radio') entry.checked = !!item.checked;
    const accelerator = item.accelerator || (typeof item.getDefaultRoleAccelerator === 'function' ? item.getDefaultRoleAccelerator() : '');
    if (accelerator) entry.accelerator = acceleratorText(accelerator);
    if (item.submenu) entry.submenu = describeMenu(item.submenu, id);
    out.push(entry);
  });
  return out;
}

/** The item `id` names, or null: it must exist, be shown, be enabled and be something to choose. */
function findMenuItem(menu, id) {
  if (typeof id !== 'string' || !ITEM_ID.test(id)) return null;
  let level = menu;
  let item = null;
  for (const part of id.split('.')) {
    item = level && Array.isArray(level.items) ? level.items[Number(part)] : null;
    if (!item || item.visible === false || item.enabled === false) return null;
    level = item.submenu || null;
  }
  return item && !item.submenu && item.type !== 'separator' ? item : null;
}

/** Choose the item `id` names, as a click in the native menu would. False when there is no such item. */
function clickMenuItem(menu, id, window) {
  const item = findMenuItem(menu, id);
  if (!item || typeof item.click !== 'function') return false;
  item.click({}, window, window ? window.webContents : undefined);
  return true;
}

/** { color, symbolColor } when both are "#rrggbb", else null. */
function overlayColors(value) {
  const color = value && value.color;
  const symbolColor = value && value.symbolColor;
  return typeof color === 'string' && typeof symbolColor === 'string' && COLOR.test(color) && COLOR.test(symbolColor)
    ? { color: color.toLowerCase(), symbolColor: symbolColor.toLowerCase() }
    : null;
}

/**
 * Bring the window in front of whatever is there: the browser, when a sign-in
 * the user finished in it is over. What an app may do differs:
 *   Windows ignores focus(), show() and moveTop() from an app that is not the
 *   one in front (measured with another app's window in front: ours stayed
 *   behind it). "Always on top" raises the window but leaves the keyboard with
 *   the other app. Restoring a minimised window is what Windows honours: it
 *   comes up in front and has the keyboard, in the state it was in (maximised
 *   stays maximised). So a window that is behind is minimised and restored.
 *   macOS brings an app forward from the background only when it "steals".
 * Returns whether there was a window to raise.
 */
function bringToFront(win, { app, platform = process.platform } = {}) {
  if (!win || win.isDestroyed()) return false;
  try {
    if (!win.isVisible()) win.show();
    if (win.isMinimized()) win.restore();
    else if (platform === 'win32' && !win.isFocused()) {
      win.minimize();
      win.restore();
    }
    if (platform === 'darwin') app?.focus?.({ steal: true });
    else if (platform !== 'win32') win.moveTop();
    win.focus();
    return true;
  } catch {
    return false; // the window is going away
  }
}

/**
 * The page's side of the window. Only the app's own page is answered
 * (isAllowedSender); the title bar only on a platform that has it.
 */
function registerWindowChrome({ ipcMain, Menu, app, getWindow, isAllowedSender, platform = process.platform }) {
  const active = usesTitleBar(platform);
  const window = () => {
    const w = getWindow();
    return w && !w.isDestroyed() ? w : null;
  };
  ipcMain.on(FOCUS_CHANNEL, (event) => {
    if (isAllowedSender(event)) bringToFront(window(), { app, platform });
  });
  ipcMain.handle(MENU_CHANNEL, (event) => {
    if (!active || !isAllowedSender(event)) return [];
    return describeMenu(Menu.getApplicationMenu());
  });
  ipcMain.handle(MENU_CLICK_CHANNEL, (event, id) => {
    if (!active || !isAllowedSender(event)) return false;
    return clickMenuItem(Menu.getApplicationMenu(), id, window());
  });
  ipcMain.on(CHROME_CHANNEL, (event, value) => {
    const w = window();
    const colors = overlayColors(value);
    if (!active || !isAllowedSender(event) || !w || !colors || typeof w.setTitleBarOverlay !== 'function') return;
    try {
      w.setTitleBarOverlay({ ...colors, height: TITLE_BAR_HEIGHT });
    } catch {
      /* the window is going away */
    }
  });
}

module.exports = {
  MENU_CHANNEL,
  MENU_CLICK_CHANNEL,
  CHROME_CHANNEL,
  FOCUS_CHANNEL,
  TITLE_BAR_HEIGHT,
  usesTitleBar,
  titleBarOptions,
  acceleratorText,
  describeMenu,
  findMenuItem,
  clickMenuItem,
  overlayColors,
  bringToFront,
  registerWindowChrome,
};
