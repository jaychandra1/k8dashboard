// Generates the Microsoft Store (AppX/MSIX) logo assets in build/appx/ from
// build/icon.png — the same artwork as the Windows .exe icon — so the Store
// listing, Start menu and taskbar show KubePilot's own icon instead of
// electron-builder's placeholders. Run after changing the icon:
//
//   npx electron scripts/generate-appx-assets.cjs
//
// Each asset is the icon centred on a transparent canvas of the exact size the
// AppX manifest declares (the tile colour comes from build.appx.backgroundColor
// in package.json). Drawn in a hidden window with a high-quality canvas
// downscale; the output PNGs are committed.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'build', 'icon.png');
const OUT = path.join(ROOT, 'build', 'appx');

// [file, width, height, icon size as a fraction of the shorter side]
const ASSETS = [
  ['StoreLogo.png', 50, 50, 1],
  ['Square44x44Logo.png', 44, 44, 1],
  ['SmallTile.png', 71, 71, 0.8],
  ['Square150x150Logo.png', 150, 150, 0.7],
  ['Wide310x150Logo.png', 310, 150, 0.7],
  ['LargeTile.png', 310, 310, 0.7],
  ['SplashScreen.png', 620, 300, 0.7],
];

const render = `async ({ src, w, h, frac }) => {
  const img = new Image();
  img.src = src;
  await img.decode();
  // Halve repeatedly before the final draw: one big downscale aliases.
  let cur = img, size = img.width;
  const target = Math.round(Math.min(w, h) * frac);
  while (size / 2 >= target) {
    const c = document.createElement('canvas');
    c.width = c.height = Math.round(size / 2);
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(cur, 0, 0, c.width, c.height);
    cur = c; size = c.width;
  }
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, Math.round((w - target) / 2), Math.round((h - target) / 2), target, target);
  return out.toDataURL('image/png');
}`;

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await win.loadURL('data:text/html,<!doctype html><title>appx</title>');
    const src = `data:image/png;base64,${fs.readFileSync(SRC).toString('base64')}`;
    fs.mkdirSync(OUT, { recursive: true });
    for (const [file, w, h, frac] of ASSETS) {
      const dataUrl = await win.webContents.executeJavaScript(`(${render})(${JSON.stringify({ src, w, h, frac })})`);
      fs.writeFileSync(path.join(OUT, file), Buffer.from(dataUrl.split(',')[1], 'base64'));
      console.log(`  • ${file} ${w}x${h}`);
    }
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
  app.quit();
});
