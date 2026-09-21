// Regression tests for the pod terminal (node-pty).
//
// The bug: node-pty's `spawn-helper` binary lost its execute bit, so every
// pty.spawn() failed with "posix_spawnp failed" and no pod shell could start.
// These tests would have caught it, and guard the fix in lib/pty-helper.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ensurePtyHelperExecutable, spawnHelperPaths } from '../lib/pty-helper.mjs';

const isWindows = process.platform === 'win32';
// node-pty's `spawn-helper` binary (and the "posix_spawnp failed" bug it caused)
// is macOS-only — Linux uses forkpty directly and ships no helper. So the
// helper-specific assertions run on Darwin; the generic PTY-spawn check runs on
// any Unix.
const isDarwin = process.platform === 'darwin';
const PTY_TIMEOUT_MS = 4000;

// Whatever a test does to the helper's mode, put it back — even on failure —
// so a broken assertion can never leave the checkout with a dead terminal.
const modeRestores = [];
after(() => {
  for (const { file, mode } of modeRestores.splice(0)) {
    try {
      fs.chmodSync(file, mode);
    } catch {
      /* file gone */
    }
  }
});
function rememberMode(file) {
  modeRestores.push({ file, mode: fs.statSync(file).mode & 0o777 });
}

// Run a command through node-pty and resolve with its output. This is the
// operation that failed in production — a real end-to-end check of the PTY.
// A PTY that never exits is a FAILURE (rejects), not a silent pass.
function ptyRun(pty, file, args) {
  return new Promise((resolve, reject) => {
    let out = '';
    let term;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        term?.kill();
      } catch {
        /* ignore */
      }
      reject(
        new Error(
          `PTY did not exit within ${PTY_TIMEOUT_MS}ms (output so far: ${JSON.stringify(out.slice(0, 200))})`
        )
      );
    }, PTY_TIMEOUT_MS);
    try {
      term = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: process.env.HOME || '/',
        env: process.env,
      });
    } catch (err) {
      clearTimeout(timer);
      settled = true;
      return reject(err); // e.g. "posix_spawnp failed."
    }
    term.onData((d) => {
      out += d;
    });
    term.onExit(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(out);
    });
  });
}

test('node-pty is installed and loadable', async () => {
  const pty = (await import('node-pty')).default;
  assert.equal(typeof pty.spawn, 'function');
});

test('ensurePtyHelperExecutable makes the spawn-helper executable', { skip: !isDarwin }, () => {
  ensurePtyHelperExecutable({ currentOnly: true, fromUrl: import.meta.url });
  const helpers = spawnHelperPaths({ currentOnly: true, fromUrl: import.meta.url }).filter((p) =>
    fs.existsSync(p)
  );
  assert.ok(helpers.length > 0, 'a spawn-helper binary should exist for this platform');
  for (const h of helpers) {
    assert.doesNotThrow(() => fs.accessSync(h, fs.constants.X_OK), `${h} should be executable`);
  }
});

test('node-pty can actually spawn a process (no posix_spawnp failure)', { skip: isWindows }, async () => {
  ensurePtyHelperExecutable({ currentOnly: true, fromUrl: import.meta.url });
  const pty = (await import('node-pty')).default;
  const out = await ptyRun(pty, '/bin/echo', ['k8sight-pty-ok']);
  assert.match(out, /k8sight-pty-ok/);
});

test('a stripped execute bit is self-healed and the PTY works again', { skip: !isDarwin }, async () => {
  const helpers = spawnHelperPaths({ currentOnly: true, fromUrl: import.meta.url }).filter((p) =>
    fs.existsSync(p)
  );
  assert.ok(helpers.length > 0);
  const helper = helpers[0];
  rememberMode(helper);

  try {
    // Simulate the production breakage: remove the execute bit.
    fs.chmodSync(helper, 0o644);
    assert.throws(() => fs.accessSync(helper, fs.constants.X_OK), 'exec bit should be gone');

    // The guard should restore it and report that it fixed one.
    const fixed = ensurePtyHelperExecutable({ currentOnly: true, fromUrl: import.meta.url });
    assert.ok(fixed >= 1, 'guard should have re-applied the execute bit');
    assert.doesNotThrow(() => fs.accessSync(helper, fs.constants.X_OK));

    // And a real spawn must succeed after the heal.
    const pty = (await import('node-pty')).default;
    const out = await ptyRun(pty, '/bin/echo', ['healed']);
    assert.match(out, /healed/);
  } finally {
    // Never leave the helper non-executable, whatever happened above.
    try {
      fs.chmodSync(helper, 0o755);
    } catch {
      /* best effort */
    }
  }
});
