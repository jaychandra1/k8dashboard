// Electron main process for KubePilot.
//
// Responsibilities:
//   1. Repair PATH — a Finder-launched .app inherits only a minimal PATH, so
//      kubectl (in /opt/homebrew/bin, /usr/local/bin, …) would be invisible to
//      the server's child_process calls. We reconstruct the user's real PATH.
//   2. Generate a per-launch API token and start server.js as a utility
//      process on a port we know is free (3001 when available, otherwise a
//      random free port). The backend only ever receives an allow-listed
//      environment — never the whole process.env.
//   3. Wait for the backend's /healthz, then load the UI with the token in the
//      URL fragment (the client stores it in sessionStorage and sends it as
//      `Authorization: Bearer …`). The window may only navigate within the
//      backend origin; everything else is denied or opened in the OS browser.
//   4. Tear the server down on quit (which triggers its port-forward cleanup).
'use strict';

const { app } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

// --- 0. CLI mode: `KubePilot --token-helper <eks|azure> …` -----------------
// Kubeconfig users written by the cloud imports (lib/paths.mjs execEntry) exec
// the packaged binary with this flag. The RunAsNode fuse is off, so
// ELECTRON_RUN_AS_NODE can't turn the app into node; instead we run the ESM
// helper ourselves, print exactly one ExecCredential JSON to stdout and exit —
// before the single-instance lock, the menu, sessions or any window. Nothing
// else may write to stdout on this path (stderr is fine).
const TOKEN_HELPER_FILES = { eks: 'eks-token.js', azure: 'azure-token.js' };

function runTokenHelper(argv) {
  const [helper, ...args] = argv;
  const fail = (message) => process.stderr.write(`kubepilot token-helper: ${message}\n`, () => app.exit(1));
  const file = TOKEN_HELPER_FILES[helper];
  if (!file) {
    fail(`unknown helper "${helper ?? ''}" (expected eks or azure)`);
    return;
  }
  // macOS: a sub-second CLI run should not bounce a Dock icon.
  try { app.dock?.hide(); } catch { /* not macOS / not available */ }
  import(pathToFileURL(path.join(__dirname, '..', file)).href)
    .then((mod) => mod.run(args))
    .then((json) => process.stdout.write(json, () => app.exit(0)))
    .catch((err) => fail((err && err.message) || String(err)));
}

const tokenHelperAt = process.argv.indexOf('--token-helper');
if (tokenHelperAt !== -1) {
  runTokenHelper(process.argv.slice(tokenHelperAt + 1));
  // CommonJS module scope: returning here means none of the GUI startup below
  // (single-instance lock, backend fork, windows) ever runs in helper mode.
  return;
}

const { BrowserWindow, shell, dialog, Menu, session, utilityProcess } = require('electron');
const os = require('os');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const PREFERRED_PORT = 3001; // used when free — keeps documented MCP URLs stable
const READY_TIMEOUT_MS = 30000;

let backendPort = null;
let backendOrigin = null; // e.g. http://127.0.0.1:3001
let authToken = null;
let serverProcess = null;
let mainWindow = null;

// Native "Clusters" menu state (mirrors the in-app top-bar cluster switcher).
const CLUSTERS_POLL_MS = 15_000;
let clusters = { current: null, contexts: [], pins: [] };
let clustersKey = ''; // JSON of `clusters` as last rendered into the menu
let clustersTimer = null; // periodic refresh while the window is focused
const debug = (...args) => {
  if (process.env.KUBEPILOT_DEBUG) console.debug('[KubePilot]', ...args);
};

// --- 1. PATH repair -------------------------------------------------------
// Ask the user's login shell for its PATH, then union with the usual GUI-app
// blind spots. Falls back gracefully if the shell can't be queried. On Windows
// the inherited PATH is already the user's full PATH, so no probe is needed.
function resolveUserPath() {
  const inherited = process.env.PATH || process.env.Path || '';
  if (process.platform === 'win32') return inherited;

  const common = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), 'bin'),
  ];

  let shellPath = '';
  try {
    const userShell = process.env.SHELL || '/bin/zsh';
    // A *login* (non-interactive) shell: ~/.zprofile / ~/.profile PATH edits
    // apply, but interactive rc files (~/.zshrc, which may prompt, print or
    // launch tools) are NOT executed.
    shellPath = execFileSync(userShell, ['-lc', 'printf "%s" "$PATH"'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Non-fatal — we still have `common` and the inherited PATH.
  }

  const parts = [
    ...(shellPath ? shellPath.split(path.delimiter) : []),
    ...(inherited ? inherited.split(path.delimiter) : []),
    ...common,
  ].filter(Boolean);

  return [...new Set(parts)].join(path.delimiter);
}

// --- 2. Backend environment (allow-list) ----------------------------------
// Only what the backend needs to find tools, kubeconfigs and cloud/LLM
// credentials the user deliberately exported. Nothing else leaks through
// (e.g. unrelated tokens, Electron/Chromium internals, debugger settings).
const ENV_EXACT = new Set([
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'KUBECONFIG',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SystemRoot',
  'SYSTEMROOT',
  'APPDATA',
  'LOCALAPPDATA',
  'COMSPEC',
  'ComSpec',
  'PATHEXT',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'ALLOWED_HOSTS',
  'ALLOWED_ORIGINS',
  'RATE_LIMIT_MAX',
]);
// K8DASHBOARD_ / K8SIGHT_ are the previous product names; lib/paths.mjs still
// reads them as fallbacks, so they are forwarded too.
const ENV_PREFIXES = [
  'LLM_',
  'MCP_',
  'AWS_',
  'AZURE_',
  'GOOGLE_',
  'KUBE',
  'KUBEPILOT_',
  'K8DASHBOARD_',
  'K8SIGHT_',
];

function backendEnv({ fixedPath, port, token }) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (ENV_EXACT.has(k) || ENV_PREFIXES.some((p) => k.startsWith(p))) env[k] = v;
  }
  // Never forward anything that could turn the utility process into an
  // arbitrary-code loader or change what server.js binds. KUBEPILOT_DEMO is
  // the test-only synthetic-cluster fixture; the desktop app never offers it.
  for (const k of ['NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'ELECTRON_RUN_AS_NODE', 'HOST', 'PORT', 'KUBEPILOT_DEMO'])
    delete env[k];
  env.PATH = fixedPath;
  if (process.platform === 'win32') env.Path = fixedPath;
  env.NODE_ENV = 'production';
  env.HOST = '127.0.0.1';
  env.PORT = String(port);
  env.KUBEPILOT_TOKEN = token;
  // The app binary the backend must write into kubeconfig exec entries
  // (`<exe> --token-helper …`); the utility process's own execPath may differ.
  env.KUBEPILOT_APP_EXEC = process.execPath;
  return env;
}

// Pick a port we can bind *right now*. Prefer 3001 (documented MCP URL); fall
// back to an OS-assigned free port. We never "adopt" a process already
// listening on 3001 — that could be anything, and we'd hand it our token.
function findFreePort(preferred) {
  const tryBind = (port) =>
    new Promise((resolve) => {
      const srv = net.createServer();
      srv.unref();
      srv.once('error', () => resolve(null));
      srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
        const { port: bound } = srv.address();
        srv.close(() => resolve(bound));
      });
    });
  return tryBind(preferred).then((p) => (p !== null ? p : tryBind(0)));
}

// --- 3. Start the backend -------------------------------------------------
// The backend is ESM (`"type": "module"`). Node's native ESM loader does NOT
// read from inside an asar archive (Electron's asar shim only patches CommonJS
// require/fs), so `import './lib/pty-helper.mjs'` from a packed server.js fails
// at launch. We therefore ship the app unpacked (`asar: false`); server.js and
// node_modules live on the real filesystem, where the ESM loader can read them.
// It's launched with utilityProcess.fork() (not `node server.js`) so it runs on
// Electron's bundled Node; server.js resolves client/dist, VERSION and
// node_modules via import.meta.url.
function serverRoot() {
  return app.getAppPath(); // .../Contents/Resources/app (packaged) or project root (dev)
}

function startServer({ fixedPath, port, token }) {
  const root = serverRoot();
  const serverEntry = path.join(root, 'server.js');

  let stderrTail = '';
  try {
    serverProcess = utilityProcess.fork(serverEntry, [], {
      // Don't set cwd to an asar path (it isn't a real dir) — server.js uses
      // import.meta.url, not cwd, so the default working directory is fine.
      env: backendEnv({ fixedPath, port, token }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    dialog.showErrorBox('KubePilot', `Failed to start the backend:\n${err.message}`);
    app.quit();
    return;
  }

  serverProcess.stdout?.on('data', (d) => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr?.on('data', (d) => {
    stderrTail = (stderrTail + d).slice(-2000);
    process.stderr.write(`[server] ${d}`);
  });

  // utilityProcess 'exit' reports the exit code only (no signal argument).
  serverProcess.on('exit', (code) => {
    serverProcess = null;
    // If the server dies unexpectedly while the app is up, restart it in place
    // (a crash, an OOM kill, or another process taking the port must not take
    // the whole desktop app down). Only after repeated failures in a short
    // window do we give up and tell the user.
    if (!app.isQuitting && code !== 0 && code !== null) {
      const portTaken = /EADDRINUSE|already in use/i.test(stderrTail);
      const detail = portTaken
        ? `Port ${port} was taken by another process.`
        : `The backend exited unexpectedly (code ${code}).` +
          (stderrTail.trim() ? `\n\n${stderrTail.trim().split('\n').slice(-4).join('\n')}` : '');
      restartBackend(detail).then((ok) => {
        if (ok || app.isQuitting) return;
        dialog.showErrorBox('KubePilot', `${detail}\n\nKubePilot tried to restart it ${MAX_RESTARTS} times without success. Relaunch the app.`);
        app.quit();
      });
    }
  });
}

// Restart the backend after an unexpected exit: at most MAX_RESTARTS times per
// RESTART_WINDOW_MS, preferring the port we already had (a different one is
// fine — the window is reloaded on the new origin with the same token).
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;
let restartTimes = [];
let restarting = false;
async function restartBackend(reason) {
  if (restarting) return true; // a restart is already in flight
  const now = Date.now();
  restartTimes = restartTimes.filter((t) => now - t < RESTART_WINDOW_MS);
  if (restartTimes.length >= MAX_RESTARTS) return false;
  restartTimes.push(now);
  restarting = true;
  try {
    console.warn(`[KubePilot] ${reason} Restarting the backend (${restartTimes.length}/${MAX_RESTARTS}).`);
    backendPort = await findFreePort(backendPort || PREFERRED_PORT);
    backendOrigin = `http://127.0.0.1:${backendPort}`;
    startServer({ fixedPath: resolveUserPath(), port: backendPort, token: authToken });
    if (!serverProcess) return false;
    const ready = await waitForServer();
    if (ready && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(`${backendOrigin}/#token=${authToken}`);
    }
    return ready;
  } catch (err) {
    console.error(`[KubePilot] backend restart failed: ${err.message}`);
    return false;
  } finally {
    restarting = false;
  }
}

function stopServer() {
  if (serverProcess) {
    // utilityProcess.kill() sends SIGTERM, letting server.js run its
    // killAllForwards() cleanup handler.
    serverProcess.kill();
    serverProcess = null;
  }
}

// --- 4. Wait for readiness, then show the window --------------------------
// /healthz is unauthenticated and returns {ok:true,…} only once the app has
// finished booting — unlike `/`, which any static server would answer.
function pingHealthz() {
  return new Promise((resolve) => {
    const req = http.get(
      `${backendOrigin}/healthz`,
      { headers: { Host: `127.0.0.1:${backendPort}` } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          if (body.length < 4096) body += c;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(false);
          try {
            resolve(JSON.parse(body).ok === true);
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!serverProcess) return false; // it already died; the exit handler reports why
    if (await pingHealthz()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function isBackendUrl(url) {
  try {
    return backendOrigin !== null && new URL(url).origin === backendOrigin;
  } catch {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'KubePilot',
    // Match the app's dark surface — no separate gray macOS title bar. On
    // macOS `hiddenInset` floats the traffic lights over the (black) content;
    // the frontend adds a draggable top strip via the `is-electron` class.
    backgroundColor: '#000000',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 15 },
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // No preload script exists and the renderer is a plain web app talking
      // to the backend over HTTP, so the Chromium sandbox can stay on.
      sandbox: true,
      webviewTag: false,
      devTools: !app.isPackaged,
    },
  });

  const wc = mainWindow.webContents;

  // Tag the document so the frontend can offset content below the traffic
  // lights and expose a draggable region (CSS `.is-electron` rules).
  wc.on('did-finish-load', () => {
    wc.executeJavaScript("document.documentElement.classList.add('is-electron')").catch(() => {});
    // First fill of the native Clusters menu once the UI (not loading.html) is up.
    if (isBackendUrl(wc.getURL())) refreshClustersMenu();
  });

  // Keep the native Clusters menu in sync while the window is in use: on
  // focus, then every CLUSTERS_POLL_MS while focused (two cheap GETs).
  mainWindow.on('focus', () => {
    refreshClustersMenu();
    startClustersPolling();
  });
  mainWindow.on('blur', stopClustersPolling);

  // Only the backend origin may be navigated to inside the window. The
  // loading page is loaded by us via loadFile (which doesn't trigger these
  // events), so a `file:` destination here is never legitimate either.
  const guardNavigation = (event, url) => {
    if (!isBackendUrl(url)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    }
  };
  wc.on('will-navigate', guardNavigation);
  wc.on('will-redirect', guardNavigation);
  wc.on('will-attach-webview', (event) => event.preventDefault());

  // Open target=_blank / external links in the default browser, not a new window.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  // Show a lightweight loading page immediately.
  mainWindow.loadFile(path.join(__dirname, 'loading.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('closed', () => {
    stopClustersPolling();
    mainWindow = null;
  });
}

// --- Native "Clusters" menu -----------------------------------------------
// The main process has no preload/IPC. It reads the same backend the renderer
// uses (with the token it generated) and tells the renderer what happened via
// a DOM event the app listens for:
//   window.dispatchEvent(new CustomEvent('kubepilot:host', { detail }))
//   detail = { type: 'context-changed', context }
//          | { type: 'open-contexts' }
//          | { type: 'add-cluster', provider: 'aws' | 'azure' }
// Nothing here blocks startup; failures are logged at debug and ignored.
function backendJson(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    if (!backendOrigin || !authToken) return reject(new Error('backend not ready'));
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      `${backendOrigin}${apiPath}`,
      {
        method,
        headers: {
          Host: `127.0.0.1:${backendPort}`,
          Authorization: `Bearer ${authToken}`,
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          if (data.length < 1_000_000) data += c;
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            /* non-JSON body */
          }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error(`${method} ${apiPath} → ${res.statusCode}${parsed && parsed.error ? `: ${parsed.error}` : ''}`));
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error(`${method} ${apiPath} timed out`)));
    if (payload) req.write(payload);
    req.end();
  });
}

function notifyRenderer(detail) {
  const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  if (!wc || !isBackendUrl(wc.getURL())) return;
  wc.executeJavaScript(`window.dispatchEvent(new CustomEvent('kubepilot:host', { detail: ${JSON.stringify(detail)} }))`).catch(() => {});
}

async function refreshClustersMenu({ force = false } = {}) {
  if (!backendOrigin || !authToken) return;
  try {
    const [status, pins] = await Promise.all([backendJson('GET', '/api/config/status'), backendJson('GET', '/api/settings/pins')]);
    const str = (v) => typeof v === 'string';
    const next = {
      current: status && str(status.currentContext) ? status.currentContext : null,
      contexts: status && Array.isArray(status.contexts) ? status.contexts.filter(str) : [],
      pins: pins && Array.isArray(pins.pins) ? pins.pins.filter(str) : [],
    };
    const key = JSON.stringify(next);
    if (!force && key === clustersKey) return;
    clusters = next;
    clustersKey = key;
    Menu.setApplicationMenu(buildMenu());
  } catch (err) {
    debug('Clusters menu refresh skipped:', err.message);
  }
}

function startClustersPolling() {
  stopClustersPolling();
  clustersTimer = setInterval(() => refreshClustersMenu(), CLUSTERS_POLL_MS);
  if (typeof clustersTimer.unref === 'function') clustersTimer.unref();
}

function stopClustersPolling() {
  if (clustersTimer) {
    clearInterval(clustersTimer);
    clustersTimer = null;
  }
}

async function switchClusterFromMenu(contextName) {
  if (contextName === clusters.current) return;
  try {
    await backendJson('POST', '/api/config/context', { contextName });
    // The renderer runs its normal post-switch path (route reset, config
    // status + auth re-check, toast) without POSTing again.
    notifyRenderer({ type: 'context-changed', context: contextName });
  } catch (err) {
    debug('context switch from menu failed:', err.message);
  }
  // Force a rebuild so the radio check reflects the backend's actual context
  // (also reverts it when the switch failed).
  await refreshClustersMenu({ force: true });
}

// `&` is a mnemonic marker in Windows/Linux menu labels.
const menuLabel = (s) => String(s).replace(/&/g, '&&');

function clustersMenu() {
  const { current, contexts, pins } = clusters;
  const known = new Set(contexts);
  // Same rule as the in-app switcher: pins that still exist (plus the active one).
  const pinned = pins.filter((c) => known.has(c) || c === current);
  const items = pinned.length
    ? pinned.map((ctx) => ({ label: menuLabel(ctx), type: 'radio', checked: ctx === current, click: () => switchClusterFromMenu(ctx) }))
    : [{ label: 'No pinned clusters', enabled: false }];
  return {
    label: 'Clusters',
    submenu: [
      ...items,
      { type: 'separator' },
      { label: 'All contexts…', click: () => notifyRenderer({ type: 'open-contexts' }) },
      { label: 'Add AWS EKS cluster…', click: () => notifyRenderer({ type: 'add-cluster', provider: 'aws' }) },
      { label: 'Add Azure AKS cluster…', click: () => notifyRenderer({ type: 'add-cluster', provider: 'azure' }) },
    ],
  };
}

async function boot() {
  createWindow();

  // Fresh credentials and a port we own for every launch.
  authToken = crypto.randomBytes(32).toString('base64url');
  backendPort = await findFreePort(PREFERRED_PORT);
  backendOrigin = `http://127.0.0.1:${backendPort}`;
  if (backendPort !== PREFERRED_PORT) {
    console.warn(`[KubePilot] port ${PREFERRED_PORT} is busy; backend will use ${backendPort}`);
  }

  startServer({ fixedPath: resolveUserPath(), port: backendPort, token: authToken });
  if (!serverProcess) return;

  const ready = await waitForServer();
  if (!mainWindow) return; // window closed while we waited

  if (ready) {
    // The token travels in the fragment: it never hits the server log line
    // for the request and the client moves it into sessionStorage on load.
    mainWindow.loadURL(`${backendOrigin}/#token=${authToken}`);
  } else if (serverProcess) {
    dialog.showErrorBox(
      'KubePilot',
      `The backend did not become ready on port ${backendPort} within ${READY_TIMEOUT_MS / 1000}s.\n` +
        'Check the log output and relaunch the app.'
    );
    app.quit();
  }
}

// --- App lifecycle --------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('web-contents-created', (_event, contents) => {
    // Belt and braces for any webContents we didn't create explicitly.
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
  });

  app.whenReady().then(() => {
    // The UI never needs camera, mic, geolocation, notifications, clipboard
    // read, etc. Deny every permission request and check outright.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);

    Menu.setApplicationMenu(buildMenu());
    boot();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) boot();
    });
  });
}

app.on('window-all-closed', () => {
  // Server-backed app: closing the window quits everything (incl. the backend).
  app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopServer();
});

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        // DevTools are a development aid only; in a packaged build the
        // renderer's devTools preference is off too.
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    clustersMenu(),
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }],
    },
  ];
  return Menu.buildFromTemplate(template);
}
