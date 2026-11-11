// The desktop app's startup splash (electron/loading.html): a self-contained
// page that loads nothing, showing the same turning helm as the app's own
// loading screen (client/src/components/shell/LoadingScreen.jsx, HelmWheel).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../lib/paths.mjs';

const html = fs.readFileSync(path.join(ROOT_DIR, 'electron', 'loading.html'), 'utf8');

test('the splash loads nothing: no image, script or link, under a CSP that allows only its own styles', () => {
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'" \/>/);
  for (const banned of ['<img', '<script', '<link', 'data:', 'http://', 'https://', 'url(']) assert.equal(html.includes(banned), false, banned);
  assert.ok(html.length < 8000, `${html.length} bytes`);
});

test('the helm is the one the app draws: a rim, a hub and seven spokes at the same points', () => {
  const component = fs.readFileSync(path.join(ROOT_DIR, 'client', 'src', 'components', 'shell', 'LoadingScreen.jsx'), 'utf8');
  // The component computes its spokes; the splash carries the numbers.
  assert.match(component, /const \[x1, y1\] = at\(13\);\s*const \[x2, y2\] = at\(44\);/);
  const expected = Array.from({ length: 7 }, (_, i) => {
    const a = ((-90 + (i * 360) / 7) * Math.PI) / 180;
    const at = (r) => [(50 + r * Math.cos(a)).toFixed(2), (50 + r * Math.sin(a)).toFixed(2)];
    return [...at(13), ...at(44)];
  });
  const lines = [...html.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)" stroke-width="7" \/>/g)].map((m) => m.slice(1));
  assert.deepEqual(lines, expected);
  assert.equal((html.match(/<circle /g) || []).length, 2);
  for (const shared of ['<circle cx="50" cy="50" r="27" stroke-width="8" />', '<circle cx="50" cy="50" r="7.5" stroke-width="6" />']) assert.ok(html.includes(shared), shared);
  assert.ok(component.includes('<circle cx="50" cy="50" r="27" strokeWidth="8" />') && component.includes('<circle cx="50" cy="50" r="7.5" strokeWidth="6" />'));
});

test('the wheel turns, stands still under "reduce motion", and the mark is hidden from screen readers', () => {
  assert.match(html, /\.wheel \{[^}]*animation: spin 7s linear infinite;/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\) \{\s*\.wheel, \.mark::after \{ animation: none; \}/);
  assert.match(html, /<div class="mark" aria-hidden="true">/);
  assert.match(html, /<div class="title">K<span class="eight">8<\/span>Board<\/div>/);
});
