// Regenerate the README / website screenshots from the current build, using
// the built-in demo cluster (KUBEPILOT_DEMO=1), so no real cluster data ever
// appears in them.
//
//   npm run build                                 # client/dist must be current
//   npx electron scripts/capture-screenshots.cjs  # all views, dark + light
//   npx electron scripts/capture-screenshots.cjs dashboard security   # some views
//
// Writes website/assets/screenshot-<view>-<dark|light>.png at 2946×1760 (a
// 1473×880 window at 2×) and docs/screenshot-dashboard.png (the dark dashboard,
// used by the README). The backend runs on SHOTS_PORT (default 3089) with a
// throwaway HOME and no kubeconfig; nothing on the machine is read or changed.
'use strict';

const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.SHOTS_PORT || 3089);
const TOKEN = crypto.randomBytes(24).toString('base64url');
const BASE = `http://127.0.0.1:${PORT}`;
const WIDTH = 1473;
const HEIGHT = 880;
const SCALE = 2;
const OUT_DIR = path.join(ROOT, 'website', 'assets');
const README_SHOT = path.join(ROOT, 'docs', 'screenshot-dashboard.png');
const THEMES = ['dark', 'light'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[shots]', ...a);

// ---- demo backend ---------------------------------------------------------
function request(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(`${BASE}${p}`, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function startBackend() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kubepilot-shots-'));
  const child = spawn('node', ['server.js'], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      KUBEPILOT_DEMO: '1',
      KUBEPILOT_TOKEN: TOKEN,
      HOST: '127.0.0.1',
      PORT: String(PORT),
      KUBECONFIG: path.join(home, 'no-kubeconfig'),
      HOME: home,
      USERPROFILE: home,
      NODE_ENV: 'production',
    },
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`backend exited (${child.exitCode}): ${stderr}`);
    try { if ((await request('GET', '/healthz')).status === 200) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`backend did not start on ${BASE}: ${stderr}`);
    await sleep(250);
  }
  const sw = await request('POST', '/api/config/context', { contextName: 'demo-cluster' });
  if (sw.status !== 200) throw new Error(`could not enter the demo cluster: ${sw.status} ${sw.text}`);
  return { child, home };
}

// ---- page helpers -----------------------------------------------------------
let win;
const js = (code) => win.webContents.executeJavaScript(code, true);

async function waitFor(expr, label, timeout = 20000) {
  const end = Date.now() + timeout;
  for (;;) {
    try { if (await js(`!!(${expr})`)) return; } catch { /* page navigating */ }
    if (Date.now() > end) {
      let seen = '';
      try { seen = await js("location.href + ' :: ' + (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 300)"); } catch { /* ignore */ }
      throw new Error(`timed out waiting for ${label} (page: ${seen})`);
    }
    await sleep(150);
  }
}

// Fonts loaded, no loading screen, then a pause for transitions to finish.
async function settle(ms = 900) {
  await js('document.fonts ? document.fonts.ready.then(() => true) : true');
  await waitFor("!document.querySelector('.loading-screen')", 'loading screen to clear');
  await sleep(ms);
}

// A fresh page for every shot: no open panels, palettes or drawers carried over.
// The changing query string forces a full load (a URL that differs only after
// `#` is an in-page navigation, and the app reads #token= only at startup).
let loads = 0;
async function open(hash, ready, label) {
  loads += 1;
  await win.loadURL(`${BASE}/?shot=${loads}#token=${TOKEN}`);
  await emulateViewport();
  await waitFor("document.querySelector('.nav-sidebar')", 'app shell');
  await js(`location.hash = ${JSON.stringify(hash)}`);
  await waitFor(ready, label);
  await settle();
}

// The viewport and pixel ratio come from the DevTools protocol (as in
// Puppeteer), so the shot is exactly WIDTH×HEIGHT at SCALE× whatever the
// display's size or scaling — a window that large would not fit most screens.
const cdp = (method, params = {}) => win.webContents.debugger.sendCommand(method, params);
async function emulateViewport() {
  if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
  await cdp('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false, screenWidth: WIDTH, screenHeight: HEIGHT });
}

const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });

async function capture(name, theme) {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const png = Buffer.from(data, 'base64');
  const { width, height } = pngSize(png);
  const file = path.join(OUT_DIR, `screenshot-${name}-${theme}.png`);
  fs.writeFileSync(file, png);
  log(`${path.relative(ROOT, file)}  ${width}x${height}`);
  if (width !== WIDTH * SCALE || height !== HEIGHT * SCALE) log(`  warning: expected ${WIDTH * SCALE}x${HEIGHT * SCALE}`);
  return file;
}

// ---- the views ----------------------------------------------------------------
// The AI tool shown in the top bar: the Claude Code agent for most shots, the
// built-in assistant for the assistant shot.
const AI_AGENT = { mode: 'agent', id: 'claude', name: 'Claude Code' };
const AI_BUILTIN = { mode: 'builtin' };
const setAiTool = (cfg) => js(`localStorage.setItem('aiAgentConfig', ${JSON.stringify(JSON.stringify(cfg))})`);

// The demo's `shop` namespace has the richest graph (default has one app).
async function topologyOfShop() {
  await open('#/topology', "document.querySelectorAll('.topo-node-card').length > 0", 'topology graph');
  await js(`(() => {
    const sel = Array.from(document.querySelectorAll('main select')).find((s) => Array.from(s.options).some((o) => o.value === 'shop'));
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'shop');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor("document.querySelectorAll('.topo-node-card').length > 6", 'topology of the shop namespace');
  await settle();
}

const VIEWS = {
  async dashboard() {
    await open('#/cluster', "document.querySelectorAll('.kpi-row > *').length >= 5 && document.querySelector('.cluster-info-card')", 'cluster dashboard');
  },
  // "An AI assistant that actually reads your cluster": the built-in assistant
  // answering from the demo cluster (tool calls + streamed answer).
  async agent() {
    await setAiTool(AI_BUILTIN);
    await open('#/cluster', "document.querySelectorAll('.kpi-row > *').length >= 5", 'cluster dashboard');
    await js("window.dispatchEvent(new CustomEvent('assistant:ask', { detail: { prompt: 'Why is the checkout pod in shop crash-looping?' } }))");
    await waitFor("(document.querySelector('.assistant-log')?.textContent || '').includes('STRIPE_WEBHOOK_SECRET') && !document.querySelector('.assistant-send.stop') && !document.querySelector('.assistant-thinking')", 'assistant answer');
    await settle(1200);
    await setAiTool(AI_AGENT);
  },
  async topology() {
    await topologyOfShop();
  },
  async cmdk() {
    await topologyOfShop();
    await js("document.querySelector('.topbar-kbd').click()");
    await waitFor("document.querySelector('.cmdk-input')", 'command palette');
    await settle(600);
  },
  async argocd() {
    await open('#/argocd/dashboard', "document.querySelectorAll('.argo-card').length >= 3", 'Argo CD dashboard');
  },
  async 'argocd-tree'() {
    await open('#/argocd/applications', "Array.from(document.querySelectorAll('tbody tr')).some((r) => r.textContent.includes('frontend'))", 'Argo CD applications');
    await js("Array.from(document.querySelectorAll('tbody tr')).find((r) => r.textContent.includes('frontend')).click()");
    await sleep(300);
    await js("location.hash = '#/argocd/view'");
    await waitFor("document.querySelectorAll('.argo-gnode').length >= 3", 'Argo CD resource tree');
    await settle();
  },
  async security() {
    await open('#/security/overview', "document.querySelectorAll('.ui-donut').length >= 3", 'Security Center');
  },
};

async function main() {
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-') && !a.endsWith('.cjs') && a !== '.');
  const names = wanted.length ? wanted : Object.keys(VIEWS);
  const unknown = names.filter((n) => !VIEWS[n]);
  if (unknown.length) throw new Error(`unknown view(s): ${unknown.join(', ')} (have: ${Object.keys(VIEWS).join(', ')})`);

  log(`starting the demo backend on ${BASE}`);
  const { child, home } = await startBackend();
  try {
    win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      useContentSize: true,
      show: false,
      paintWhenInitiallyHidden: true,
      backgroundColor: '#000000',
      // In-memory session: theme and AI settings set below never touch a real profile.
      // Offscreen rendering keeps producing frames although the window is never shown.
      webPreferences: { partition: 'kubepilot-shots', sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: true },
    });
    for (const theme of THEMES) {
      await win.loadURL(BASE);
      await emulateViewport();
      await js(`localStorage.setItem('theme', '${theme}')`);
      await setAiTool(AI_AGENT);
      for (const name of names) {
        await VIEWS[name]();
        const file = await capture(name, theme);
        if (name === 'dashboard' && theme === 'dark') {
          fs.copyFileSync(file, README_SHOT);
          log(`${path.relative(ROOT, README_SHOT)}  (copy of the dark dashboard)`);
        }
      }
    }
  } finally {
    child.kill();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

app.whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((err) => { console.error('[shots] failed:', err.message); app.exit(1); });
