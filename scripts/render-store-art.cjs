// Render the Microsoft Store logo and promotional art from the icon master
// (build/source/k8board-icon.svg), so every size comes from one design.
//
//   npx electron scripts/render-store-art.cjs
//
// Writes "Microsoft store/images/":
//   super-hero-art-1920x1080.png, super-hero-art-3840x2160.png   16:9, no text, no UI
//   poster-art-720x1080.png, poster-art-1440x2160.png             2:3, icon + name in the top two-thirds
//   box-art-1080x1080.png, box-art-2160x2160.png                  1:1, icon + name in the top two-thirds
//   store-tile-icon-300x300.png, -150x150.png, -71x71.png         the icon on transparent
// Microsoft's rules: nothing that matters in the bottom third (the Store lays
// text over it), and no text on the super hero art.
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'Microsoft store', 'images');
const ICON = pathToFileURL(path.join(ROOT, 'build', 'source', 'k8board-icon.svg')).href;
const FONT = pathToFileURL(
  path.join(ROOT, 'client', 'node_modules', '@fontsource-variable', 'figtree', 'files', 'figtree-latin-wght-normal.woff2')
).href;

const ASSETS = [
  { file: 'super-hero-art-1920x1080.png', w: 1920, h: 1080, kind: 'hero' },
  { file: 'super-hero-art-3840x2160.png', w: 3840, h: 2160, kind: 'hero' },
  { file: 'poster-art-720x1080.png', w: 720, h: 1080, kind: 'titled' },
  { file: 'poster-art-1440x2160.png', w: 1440, h: 2160, kind: 'titled' },
  { file: 'box-art-1080x1080.png', w: 1080, h: 1080, kind: 'titled' },
  { file: 'box-art-2160x2160.png', w: 2160, h: 2160, kind: 'titled' },
  { file: 'store-tile-icon-300x300.png', w: 300, h: 300, kind: 'tile' },
  { file: 'store-tile-icon-150x150.png', w: 150, h: 150, kind: 'tile' },
  { file: 'store-tile-icon-71x71.png', w: 71, h: 71, kind: 'tile' },
];

// Orbits and their dots, in a 1000-unit box stretched to the canvas.
function orbits(w, h) {
  const s = Math.min(w, h) / 1080; // stroke and dot scale
  const rings = [
    { rx: 300, ry: 150 },
    { rx: 430, ry: 225 },
    { rx: 560, ry: 300 },
    { rx: 700, ry: 380 },
  ];
  const cx = w / 2;
  const cy = h * 0.42;
  const k = Math.max(w, h * 1.4) / 1100;
  const dots = [
    [0, 0.6], [1, 3.6], [1, 5.3], [2, 2.2], [2, 4.4], [3, 0.2], [3, 2.9],
  ];
  const ring = (r) =>
    `<ellipse cx="${cx}" cy="${cy}" rx="${r.rx * k}" ry="${r.ry * k}" fill="none" stroke="rgba(56,189,248,0.16)" stroke-width="${1.6 * s}"/>`;
  const dot = ([i, a], n) => {
    const r = rings[i];
    const x = cx + Math.cos(a) * r.rx * k;
    const y = cy + Math.sin(a) * r.ry * k;
    const c = n % 2 ? '#a78bfa' : '#38bdf8';
    return `<circle cx="${x}" cy="${y}" r="${(n % 3 === 0 ? 6 : 4.5) * s}" fill="${c}" opacity="0.75" filter="url(#dg)"/>`;
  };
  return `<svg class="orbits" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
    <defs><filter id="dg" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="${3 * s}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
    <g transform="rotate(-9 ${cx} ${cy})">${rings.map(ring).join('')}${dots.map(dot).join('')}</g>
  </svg>`;
}

function page({ w, h, kind }) {
  const m = Math.min(w, h);
  const tile = kind === 'tile';
  // Hero: the icon centred in the top two-thirds. Titled: icon, then the name, both above the bottom third.
  const iconSize = tile ? m : kind === 'hero' ? h * 0.46 : m * (w < h ? 0.62 : 0.4);
  const iconTop = tile ? 0 : kind === 'hero' ? h * 0.42 - iconSize / 2 : h * (w < h ? 0.12 : 0.1);
  const titleSize = m * (w < h ? 0.135 : 0.105);
  const titleTop = iconTop + iconSize + m * 0.035;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face { font-family: "Figtree"; font-weight: 300 900; src: url("${FONT}") format("woff2"); }
    html, body { margin: 0; width: ${w}px; height: ${h}px; overflow: hidden; background: transparent; }
    .bg { position: absolute; inset: 0;
      background:
        radial-gradient(ellipse 60% 55% at 50% 42%, rgba(91, 33, 182, 0.30), transparent 70%),
        radial-gradient(ellipse 45% 40% at 50% 42%, rgba(37, 99, 235, 0.22), transparent 70%),
        linear-gradient(160deg, #0d1330 0%, #0a0f24 45%, #05070f 100%); }
    .orbits { position: absolute; inset: 0; }
    .icon { position: absolute; left: ${(w - iconSize) / 2}px; top: ${iconTop}px; width: ${iconSize}px; height: ${iconSize}px;
      ${tile ? '' : `filter: drop-shadow(0 0 ${m * 0.04}px rgba(59, 130, 246, 0.45));`} }
    .title { position: absolute; left: 0; right: 0; top: ${titleTop}px; text-align: center;
      font: 700 ${titleSize}px/1 "Figtree", sans-serif; letter-spacing: -0.02em; color: #f8fafc;
      text-shadow: 0 0 ${m * 0.03}px rgba(56, 189, 248, 0.25); }
    .title .eight { font-size: 0.66em; margin: 0 0.03em 0 0.02em; letter-spacing: 0; }
  </style></head><body>
    ${tile ? '' : `<div class="bg"></div>${orbits(w, h)}`}
    <img class="icon" src="${ICON}" alt="">
    ${kind === 'titled' ? '<div class="title">K<span class="eight">8</span>Board</div>' : ''}
  </body></html>`;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'k8board-art-'));
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true },
  });
  await win.loadURL('about:blank');
  const cdp = (m, p = {}) => win.webContents.debugger.sendCommand(m, p);
  win.webContents.debugger.attach('1.3');
  win.webContents.on('render-process-gone', (_e, d) => console.error('[art] renderer gone:', d.reason));
  try {
    for (const a of ASSETS) {
      const html = path.join(tmp, `${a.kind}-${a.w}x${a.h}.html`);
      fs.writeFileSync(html, page(a));
      await cdp('Emulation.setDeviceMetricsOverride', { width: a.w, height: a.h, deviceScaleFactor: 1, mobile: false });
      await cdp('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
      await win.loadFile(html);
      await win.webContents.executeJavaScript(
        'Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.decode().catch(() => {}))]).then(() => true)'
      );
      await new Promise((r) => setTimeout(r, 150));
      const { data } = await cdp('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
        clip: { x: 0, y: 0, width: a.w, height: a.h, scale: 1 },
      });
      const png = Buffer.from(data, 'base64');
      fs.writeFileSync(path.join(OUT, a.file), png);
      console.log(`[art] ${a.file}  ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}  ${Math.round(png.length / 1024)} KB`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

app
  .whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((err) => {
    console.error('[art] failed:', err.message);
    app.exit(1);
  });
