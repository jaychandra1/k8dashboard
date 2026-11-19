// The bridge between the app's page and the desktop shell. It is small on
// purpose:
//   - reportPdf: turn a report the page built (a self-contained HTML document)
//     into PDF bytes, for the Security Center's "Download report → PDF";
//   - the title bar (Windows, where the app draws it): a description of the
//     application menu, "this item was chosen", and the bar's two colours so
//     the caption buttons match the theme (electron/window-chrome.cjs);
//   - focusWindow: bring the window to the front when a sign-in the user
//     finished in the browser is over.
// Nothing else is exposed.
//
// This preload runs sandboxed (webPreferences.sandbox stays true), so only
// contextBridge and ipcRenderer are available; the main process checks that
// each request comes from the app's own page (electron/main.cjs, isAppPage).
const { contextBridge, ipcRenderer } = require('electron');

const windows = process.platform === 'win32';

contextBridge.exposeInMainWorld('k8boardHost', Object.freeze({
  /** html: string → Promise<Uint8Array> (the PDF). */
  reportPdf: (html) => ipcRenderer.invoke('k8board:report-pdf', String(html)),
  /** Does this copy have somewhere to check for updates? Windows: the Microsoft Store. */
  updates: windows,
  /** Does the app draw the window's title bar (with the menus in it)? Windows. */
  titleBar: windows,
  /** The application menu as data: Promise<[{ id, label, type, enabled, checked?, accelerator?, submenu? }]>. */
  menu: () => ipcRenderer.invoke('k8board:menu'),
  /** The menu item with this id was chosen: Promise<boolean>. */
  menuClick: (id) => ipcRenderer.invoke('k8board:menu-click', String(id)),
  /** The title bar's colours, "#rrggbb" each, for the caption buttons drawn over it. */
  chrome: (color, symbolColor) => ipcRenderer.send('k8board:chrome', { color: String(color), symbolColor: String(symbolColor) }),
  /** Bring the app's window to the front (a sign-in finished in the browser). */
  focusWindow: () => ipcRenderer.send('k8board:focus'),
}));
