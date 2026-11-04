// Generates every K8Board icon from the two SVG masters in build/source/:
//   k8board-icon.svg        the full artwork (64 px and up)
//   k8board-icon-small.svg  the simplified mark (16–48 px: taskbar, tray, tabs)
//
//   npx electron scripts/generate-icons.cjs
//   npx electron scripts/generate-appx-assets.cjs   # then the Store tiles
//
// Writes build/icon.png (1024, electron-builder makes the macOS .icns and Linux
// icons from it), build/icon-small.png, build/icon.ico (16–256),
// build/icon-detailed.png (README), client/public/logo*.png (sidebar,
// favicon), website/assets/icon*.png and website/assets/og-image.png. The
// output is committed; the SVGs are the source of truth.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'build', 'source');
const svg = (name) => `data:image/svg+xml;base64,${fs.readFileSync(path.join(SRC, name)).toString('base64')}`;
const FULL = svg('k8board-icon.svg');
const SMALL = svg('k8board-icon-small.svg');
const SMALL_MAX = 48; // up to this size the simplified mark reads better

const PNGS = [
  ['build/icon.png', 1024],
  ['build/icon-detailed.png', 512],
  ['build/icon-small.png', 256, SMALL],
  ['client/public/logo.png', 256],
  ['client/public/logo-detailed.png', 512],
  // The sidebar shows the logo at 30px: the simplified mark.
  ['client/public/logo-mark.png', 128, SMALL],
  ['website/assets/icon.png', 256],
  ['website/assets/icon-detailed.png', 512],
];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

// A .ico of PNG-compressed images (Windows Vista and later).
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e); header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt8(0, e + 2); header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(png.length, e + 8); header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((x) => x.png)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1300, height: 700, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<body></body>');
  const render = (src, w, h = w, extra = null) => win.webContents.executeJavaScript(`(async () => {
    const load = (s) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = s; });
    const c = document.createElement('canvas'); c.width = ${w}; c.height = ${h};
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
    const img = await load(${JSON.stringify(src)});
    ${extra || `g.drawImage(img, 0, 0, ${w}, ${h});`}
    return c.toDataURL('image/png').split(',')[1];
  })()`).then((b64) => Buffer.from(b64, 'base64'));
  const write = (rel, buf) => { fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true }); fs.writeFileSync(path.join(ROOT, rel), buf); console.log(`${rel}  ${buf.length.toLocaleString()} bytes`); };

  for (const [rel, size, src] of PNGS) write(rel, await render(src || FULL, size));
  const icoImages = [];
  for (const size of ICO_SIZES) icoImages.push({ size, png: await render(size <= SMALL_MAX ? SMALL : FULL, size) });
  write('build/icon.ico', ico(icoImages));

  // Social preview (1200×630): the icon, the name and the tagline on a dark field.
  write('website/assets/og-image.png', await render(FULL, 1200, 630, `
    const bg = g.createLinearGradient(0, 0, 1200, 630);
    bg.addColorStop(0, '#0b1224'); bg.addColorStop(1, '#05060f');
    g.fillStyle = bg; g.fillRect(0, 0, 1200, 630);
    const halo = g.createRadialGradient(330, 315, 40, 330, 315, 360);
    halo.addColorStop(0, 'rgba(59,130,246,0.35)'); halo.addColorStop(1, 'rgba(59,130,246,0)');
    g.fillStyle = halo; g.fillRect(0, 0, 1200, 630);
    g.drawImage(img, 110, 95, 440, 440);
    // The wordmark: "K", a small "8" on the baseline, "Board" (as in the app).
    const big = '700 96px "Segoe UI", system-ui, sans-serif';
    const small = '700 63px "Segoe UI", system-ui, sans-serif';
    g.fillStyle = '#f5f7fb';
    let x = 600;
    g.font = big; g.fillText('K', x, 300); x += g.measureText('K').width + 2;
    g.font = small; g.fillText('8', x, 300); x += g.measureText('8').width + 3;
    g.font = big; g.fillText('Board', x, 300);
    g.fillStyle = '#9aa7bd'; g.font = '400 34px "Segoe UI", system-ui, sans-serif';
    g.fillText('The Kubernetes desktop for', 604, 362); g.fillText('macOS, Windows and Linux', 604, 408);
  `));
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
