// Security Center → "Download report → PDF". The page builds the report as one
// self-contained HTML document (client/src/components/security/report/html.js)
// and asks for it as a PDF through electron/preload.cjs.
//
// The document never touches the disk: a private protocol on a dedicated
// in-memory session serves it to a hidden window with JavaScript turned off.
// That session may load nothing else (images inside the report are data:
// URLs), and grants no permissions. The page is then printed to an A4 PDF with
// page numbers, and the window is destroyed.

const CHANNEL = 'k8board:report-pdf';
const SCHEME = 'k8board-report';
const REPORT_URL = `${SCHEME}://report/`;
const PARTITION = 'k8board-report'; // no "persist:" prefix → memory only
const MAX_HTML = 24 * 1024 * 1024;
const TIMEOUT_MS = 90000;
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

// Chromium's footer template: needs explicit font sizes; .title, .pageNumber
// and .totalPages are filled in.
const FOOTER = '<div style="box-sizing:border-box;width:100%;padding:0 14mm;font-size:7.5px;font-family:\'Segoe UI\',-apple-system,Arial,sans-serif;color:#64748b;display:flex;justify-content:space-between">'
  + '<span class="title"></span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>';

let current = null; // the document being rendered (one at a time)

/** Is this request one the report window may make? */
const allowed = (url) => url.startsWith(`${SCHEME}:`) || url.startsWith('data:');

function reportSession(session) {
  const ses = session.fromPartition(PARTITION);
  if (!ses.protocol.isProtocolHandled(SCHEME)) {
    ses.protocol.handle(SCHEME, (req) => (current != null && req.url === REPORT_URL
      ? new Response(current, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP } })
      : new Response('', { status: 404 })));
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowed(details.url) }));
  }
  return ses;
}

async function renderReportPdf(html, { BrowserWindow, session }) {
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 1400,
    webPreferences: {
      session: reportSession(session),
      javascript: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      devTools: false,
    },
  });
  const wc = win.webContents;
  const block = (e) => e.preventDefault();
  wc.on('will-navigate', block);
  wc.on('will-redirect', block);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));

  current = html;
  let timer;
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The report took too long to render.')), TIMEOUT_MS); });
    await Promise.race([wc.loadURL(REPORT_URL), timeout]);
    return await Promise.race([wc.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margins: { top: 0.63, bottom: 0.71, left: 0.55, right: 0.55 }, // inches; matches the report's @page
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: FOOTER,
    }), timeout]);
  } finally {
    clearTimeout(timer);
    current = null;
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * Answer the page's PDF requests. `isAllowedSender(event)` decides whether a
 * request comes from the app's own page; anything else is refused. One report
 * renders at a time.
 */
function registerReportPdf({ ipcMain, BrowserWindow, session, isAllowedSender }) {
  let busy = false;
  ipcMain.handle(CHANNEL, async (event, html) => {
    if (!isAllowedSender(event)) throw new Error('Not allowed.');
    if (typeof html !== 'string' || !/^<!doctype html>/i.test(html) || html.length > MAX_HTML) throw new Error('Not a report.');
    if (busy) throw new Error('A report is already being prepared.');
    busy = true;
    try {
      return await renderReportPdf(html, { BrowserWindow, session });
    } finally {
      busy = false;
    }
  });
}

module.exports = { CHANNEL, registerReportPdf, renderReportPdf, allowed };
