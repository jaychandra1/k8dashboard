// electron/update-host.cjs — the main-process half of the updater. Uses a fake
// `app` and a fake spawn: no installer is ever started and nothing quits.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { ROOT } from './helpers/server.mjs';

const require = createRequire(import.meta.url);
const { createUpdateHost, defaultUpdateDir, MARKER } = require('../electron/update-host.cjs');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function fakeApp(version = '1.3.0') {
  const calls = { quit: 0, relaunch: [] };
  return {
    calls,
    isPackaged: true,
    getVersion: () => version,
    quit: () => {
      calls.quit += 1;
    },
    relaunch: (opts) => {
      calls.relaunch.push(opts);
    },
  };
}
function fakeSpawn() {
  const calls = [];
  const fn = (file, args, opts) => {
    calls.push({ file, args, opts });
    const child = new EventEmitter();
    child.unref = () => {};
    setImmediate(() => child.emit('spawn'));
    return child;
  };
  fn.calls = calls;
  return fn;
}
const WIN_EXE = 'C:\\Users\\u\\AppData\\Local\\Programs\\kubepilot\\KubePilot.exe';
const winInstalled = (p) =>
  p === 'C:\\Users\\u\\AppData\\Local\\Programs\\kubepilot\\Uninstall KubePilot.exe';

async function windowsHost(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-host-'));
  const app = fakeApp(extra.version);
  const spawnImpl = fakeSpawn();
  const host = await createUpdateHost({
    app,
    rootDir: ROOT,
    platform: 'win32',
    execPath: WIN_EXE,
    existsSync: winInstalled,
    dir,
    dryRun: false,
    spawnImpl,
    ...extra,
  });
  const file = path.join(dir, 'pending', 'KubePilot-windows.exe');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'installer');
  return { host, app, spawnImpl, dir, file, digest: sha('installer') };
}
const ask = (host, msg) => new Promise((resolve) => host.onMessage({ kpUpdate: 1, id: 1, ...msg }, resolve));

describe('update host (main process)', () => {
  test('Windows "Install and Restart": re-verifies, starts the installer detached with --force-run, then quits', async () => {
    const { host, app, spawnImpl, dir, file, digest } = await windowsHost();
    assert.equal(host.install.kind, 'nsis');
    const reply = await ask(host, {
      type: 'install',
      payload: { file, sha256: digest, version: '1.4.0', kind: 'nsis', when: 'now' },
    });
    assert.deepEqual(reply, { kpUpdate: 1, id: 1, ok: true, result: { restarting: true } });
    assert.deepEqual(spawnImpl.calls[0].args, ['--updated', '/S', '--force-run']);
    assert.equal(spawnImpl.calls[0].file, file);
    assert.equal(spawnImpl.calls[0].opts.detached, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')).version, '1.4.0');
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(app.calls.quit, 1);
  });

  test('refuses an installer outside the update directory or with a changed SHA-256', async () => {
    const { host, spawnImpl, file, digest } = await windowsHost();
    const outside = path.join(os.tmpdir(), `kp-outside-${process.pid}.exe`);
    fs.writeFileSync(outside, 'installer');
    try {
      const r1 = await ask(host, {
        type: 'install',
        payload: { file: outside, sha256: digest, version: '1.4.0', kind: 'nsis', when: 'now' },
      });
      assert.equal(r1.ok, false);
      assert.equal(r1.error.code, 'install_failed');
      const r2 = await ask(host, {
        type: 'install',
        payload: {
          file: path.join(path.dirname(file), '..', '..', path.basename(outside)),
          sha256: digest,
          version: '1.4.0',
          kind: 'nsis',
          when: 'now',
        },
      });
      assert.equal(r2.ok, false);
    } finally {
      fs.rmSync(outside, { force: true });
    }
    const r3 = await ask(host, {
      type: 'install',
      payload: { file, sha256: 'a'.repeat(64), version: '1.4.0', kind: 'nsis', when: 'now' },
    });
    assert.equal(r3.error.code, 'verification_failed');
    assert.equal(fs.existsSync(file), false, 'the unverifiable file is deleted');
    assert.equal(spawnImpl.calls.length, 0);
  });

  test('Windows "Later": installs (without relaunch) as KubePilot quits', async () => {
    const { host, spawnImpl, file, digest } = await windowsHost();
    const reply = await ask(host, {
      type: 'install',
      payload: { file, sha256: digest, version: '1.4.0', kind: 'nsis', when: 'on-quit' },
    });
    assert.equal(reply.result.scheduled, true);
    assert.equal(spawnImpl.calls.length, 0);
    host.onWillQuit();
    assert.deepEqual(spawnImpl.calls[0].args, ['--updated', '/S']);
    host.onWillQuit();
    assert.equal(spawnImpl.calls.length, 1, 'runs once');
  });

  test('after restart: reports whether the installer reached the new version', async () => {
    const ok = await windowsHost({ version: '1.4.0' });
    fs.writeFileSync(path.join(ok.dir, MARKER), JSON.stringify({ version: '1.4.0', from: '1.3.0' }));
    assert.deepEqual(ok.host.previousResult(), { status: 'installed', version: '1.4.0', from: '1.3.0' });
    assert.equal(fs.existsSync(path.join(ok.dir, MARKER)), false);
    assert.equal(ok.host.previousResult(), null, 'reported once');
    const failed = await windowsHost({ version: '1.3.0' });
    fs.writeFileSync(path.join(failed.dir, MARKER), JSON.stringify({ version: '1.4.0', from: '1.3.0' }));
    assert.equal(failed.host.previousResult().status, 'failed');
  });

  test('development and portable copies cannot install; dry run runs nothing', async () => {
    const dev = await windowsHost({ isPackaged: false });
    assert.equal(dev.host.install.reason, 'development');
    const r = await ask(dev.host, {
      type: 'install',
      payload: { file: dev.file, sha256: dev.digest, version: '1.4.0', kind: 'nsis', when: 'now' },
    });
    assert.equal(r.error.code, 'unsupported');
    const dry = await windowsHost({ dryRun: true });
    const d = await ask(dry.host, {
      type: 'install',
      payload: { file: dry.file, sha256: dry.digest, version: '1.4.0', kind: 'nsis', when: 'now' },
    });
    assert.equal(d.result.dryRun, true);
    assert.equal(dry.spawnImpl.calls.length, 0);
    await new Promise((res) => setTimeout(res, 350));
    assert.equal(dry.app.calls.quit, 0);
  });

  test('restart: app.relaunch + quit (an AppImage relaunches its own file)', async () => {
    const { host, app } = await windowsHost();
    const r = await ask(host, { type: 'relaunch' });
    assert.equal(r.ok, true);
    assert.deepEqual(app.calls.relaunch, [undefined]);
    await new Promise((res) => setTimeout(res, 250));
    assert.equal(app.calls.quit, 1);

    const appImage = '/home/u/Apps/KubePilot.AppImage';
    const linuxApp = fakeApp();
    const linux = await createUpdateHost({
      app: linuxApp,
      rootDir: ROOT,
      platform: 'linux',
      execPath: '/tmp/.mount_x/kubepilot',
      env: { APPIMAGE: appImage },
      existsSync: (p) => p === appImage,
      dir: os.tmpdir(),
    });
    await ask(linux, { type: 'relaunch' });
    assert.deepEqual(linuxApp.calls.relaunch, [{ execPath: appImage, args: [] }]);
  });

  test('downloads go to the OS cache directory', () => {
    assert.equal(
      defaultUpdateDir('kubepilot', {
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
        home: 'C:\\Users\\u',
      }),
      path.join('C:\\Users\\u\\AppData\\Local', 'kubepilot-updater')
    );
    assert.equal(
      defaultUpdateDir('kubepilot', { platform: 'darwin', env: {}, home: '/Users/u' }),
      path.join('/Users/u', 'Library', 'Caches', 'kubepilot-updater')
    );
    assert.equal(
      defaultUpdateDir('kubepilot', {
        platform: 'linux',
        env: { XDG_CACHE_HOME: '/home/u/.xdg' },
        home: '/home/u',
      }),
      path.join('/home/u/.xdg', 'kubepilot-updater')
    );
  });
});
