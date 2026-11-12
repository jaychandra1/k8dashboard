// K8Board was called KubePilot. Users see the new name everywhere — releases,
// the public repository, the Docker image, the Linux package — but a few
// identifiers keep the old one on purpose: installed copies depend on them to
// update in place and keep their clusters, settings and secrets. A test fails
// if one of them is "renamed" by accident, or if an old name comes back.
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

  test('updates: the signed text, the app ID and the Windows install folder are unchanged', () => {
    // Every installed version verifies SHA256SUMS.txt.sig over this exact text.
    assert.equal(signedMessage('1.8.0', 'x').toString('utf8'), 'KubePilot release 1.8.0\nx');
    // Windows upgrades in place (instead of installing a second app) only with the same app ID.
    assert.equal(pkg.build.appId, 'com.kubepilot.desktop');
    // The package name sets the Windows install folder (%LOCALAPPDATA%\Programs\kubepilot),
    // where kubeconfig exec entries point; the Linux package has its own name below.
    assert.equal(pkg.name, 'kubepilot');
  });

  test('releases: K8Board names only, from the K8Board repository', () => {
    const wf = read('.github/workflows/release.yml');
    assert.doesNotMatch(wf, /cp -- "\$f" "KubePilot-/, 'no KubePilot-named installer copies');
    assert.match(wf, /output-file: dist\/k8board-\$\{\{ needs\.verify\.outputs\.tag \}\}\.cdx\.json/);
    assert.match(wf, /pattern: k8board-\*/);
    // The app itself names no release repository (it reads none); the workflow publishes to it.
    assert.equal(pkg.releaseRepository, undefined);
    assert.match(wf, /RELEASE_REPO: jaychandra1\/K8Board/);
    assert.match(wf, /repository: jaychandra1\/K8Board/);
  });

  test('Docker: published as k8board, and as kubepilot for existing pulls', () => {
    const wf = read('.github/workflows/release.yml');
    assert.match(wf, /echo "name=ghcr\.io\/\$\{OWNER,,\}\/k8board"/);
    assert.match(wf, /echo "legacy=ghcr\.io\/\$\{OWNER,,\}\/kubepilot"/);
  });

  test('Linux: the k8board package replaces kubepilot, with a link for its one restart', () => {
    assert.equal(pkg.build.deb.packageName, 'k8board');
    const fpm = pkg.build.deb.fpm.join(' ');
    assert.match(fpm, /--replaces kubepilot/);
    assert.match(fpm, /--conflicts kubepilot/);
    assert.equal(pkg.build.linux.executableName, 'k8board');
    assert.equal(pkg.desktopName, 'k8board');
    assert.match(read('electron/after-pack.cjs'), /const LEGACY_LINUX_EXECUTABLE = 'kubepilot';/);
  });

  test('Microsoft Store: an MSIX with the k8board.exe alias', () => {
    assert.match(pkg.build.appx.artifactName, /\.msix$/);
    assert.match(read('build/appx-extensions.xml'), /<uap5:ExecutionAlias Alias="k8board\.exe" \/>/);
    assert.match(read('electron/main.cjs'), /'WindowsApps', 'k8board\.exe'/);
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
