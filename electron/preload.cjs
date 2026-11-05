// The one bridge between the app's page and the desktop shell: turn a report
// the page built (a self-contained HTML document) into PDF bytes, for the
// Security Center's "Download report → PDF". Nothing else is exposed.
//
// This preload runs sandboxed (webPreferences.sandbox stays true), so only
// contextBridge and ipcRenderer are available; the main process checks that
// the request comes from the app's own page (electron/main.cjs, REPORT_PDF).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('k8boardHost', Object.freeze({
  /** html: string → Promise<Uint8Array> (the PDF). */
  reportPdf: (html) => ipcRenderer.invoke('k8board:report-pdf', String(html)),
}));
