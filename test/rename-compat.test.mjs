// K8Board was called KubePilot. Users see the new name everywhere, but these
// identifiers keep the old one on purpose — installed copies depend on them to
// update in place and keep their clusters, settings and secrets. A test fails
// if one of them is "renamed" by accident.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signedMessage } from '../lib/updater/verify.mjs';
import { CONFIG_DIR, envVar } from '../lib/paths.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));

describe('K8Board rename: what keeps its KubePilot identity', () => {
  test('users see K8Board', () => {
    assert.equal(pkg.build.productName, 'K8Board');
    assert.equal(pkg.build.appx.displayName, 'K8Board');
    assert.match(read('client/index.html'), /<title>K8Board<\/title>/);
  });

  test('updates: the signed text, the app ID and the Linux package name are unchanged', () => {
    // Every installed version verifies SHA256SUMS.txt.sig over this exact text.
    assert.equal(signedMessage('1.8.0', 'x').toString('utf8'), 'KubePilot release 1.8.0\nx');
    // Windows upgrades in place (instead of installing a second app) only with the same app ID.
    assert.equal(pkg.build.appId, 'com.kubepilot.desktop');
    // The .deb upgrades the installed package only under the same package name.
    assert.equal(pkg.name, 'kubepilot');
    // Releases stay in the same repository.
    assert.equal(pkg.releaseRepository, 'jaychandra1/KubePilot');
  });

  test('releases also publish KubePilot-named copies for the KubePilot updaters', () => {
    const wf = read('.github/workflows/release.yml');
    assert.match(wf, /cp -- "\$f" "KubePilot-\$\{f#K8Board-\}"/);
    // …before the checksums are generated and signed.
    assert.ok(wf.indexOf('Legacy-named copies for KubePilot updaters') < wf.indexOf('Generate SHA256SUMS.txt'));
  });

  test('settings and secrets: the data folder and the Electron profile keep their names', () => {
    assert.equal(path.basename(CONFIG_DIR), 'kubepilot');
    const main = read('electron/main.cjs');
    assert.match(main, /const PROFILE_NAME = 'KubePilot';/);
    assert.match(main, /app\.setPath\('userData', path\.join\(app\.getPath\('appData'\), PROFILE_NAME\)\)/);
    // The Azure token helper mirrors the same profile (no productName lookup).
    assert.match(main, /name = PROFILE_NAME;/);
  });

  test('environment variables: K8BOARD_* first, KUBEPILOT_* still read', () => {
    const k = 'RENAME_COMPAT_PROBE';
    try {
      process.env[`KUBEPILOT_${k}`] = 'old';
      assert.equal(envVar(k), 'old');
      process.env[`K8BOARD_${k}`] = 'new';
      assert.equal(envVar(k), 'new');
    } finally {
      delete process.env[`KUBEPILOT_${k}`];
      delete process.env[`K8BOARD_${k}`];
    }
  });
});
