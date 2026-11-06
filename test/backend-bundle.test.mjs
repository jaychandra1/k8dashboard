// The desktop app ships its backend bundled: scripts/bundle-backend.mjs builds
// one file per entry point and electron/after-pack.cjs swaps them in, leaving
// only node-pty in node_modules (a few hundred files to install instead of
// ~5,000). This bundles into a temporary app folder WITHOUT node_modules and
// checks the bundles really run on their own. The whole HTTP suite can also
// run against such a folder: K8BOARD_TEST_APP_DIR=<folder> npm test.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT, startServer } from './helpers/server.mjs';

const hasRolldown = (() => {
  try { createRequire(path.join(ROOT, 'client', 'package.json')).resolve('rolldown'); return true; } catch { return false; }
})();
const MODULE_ERROR = /Cannot find (module|package)|ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|is not a function|SyntaxError/;

describe('bundled backend (desktop app)', { skip: !hasRolldown && 'client dependencies (rolldown) not installed' }, () => {
  let dir, home, srv, bundles;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-bundle-app-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-bundle-home-'));
    const { bundleBackend } = await import('../scripts/bundle-backend.mjs');
    bundles = await bundleBackend({ outDir: dir, log: null });
    for (const f of ['package.json', 'VERSION']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
    process.env.K8BOARD_TEST_APP_DIR = dir;
    try { srv = await startServer(); } finally { delete process.env.K8BOARD_TEST_APP_DIR; }
  });
  after(async () => {
    await srv?.stop();
    for (const d of [dir, home]) if (d) fs.rmSync(d, { recursive: true, force: true });
  });

  test('every entry point is bundled and loads nothing from node_modules but node-pty', () => {
    assert.deepEqual(bundles.map((b) => b.entry), ['server.js', 'eks-token.js', 'azure-token.js', 'mcp-stdio.js']);
    const byEntry = Object.fromEntries(bundles.map((b) => [b.entry, b.externals]));
    assert.deepEqual(byEntry, { 'server.js': ['node-pty'], 'eks-token.js': [], 'azure-token.js': [], 'mcp-stdio.js': [] });
  });

  test('the backend starts from the bundle and serves the demo cluster', async () => {
    const r = await srv.authed('/api/config/context', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contextName: 'demo-cluster' }) });
    assert.equal(r.status, 200);
    const s = await (await srv.authed('/api/cluster/summary')).json();
    assert.ok(s.pods.total > 0);
    assert.ok(s.workloads.deployments.total > 0);
    const mcp = await srv.authed('/api/mcp/status');
    assert.ok(mcp.status < 500);
  });

  test('the AWS token helper loads its whole credential chain', () => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, AWS_CONFIG_FILE: path.join(home, 'none'), AWS_SHARED_CREDENTIALS_FILE: path.join(home, 'none'), AWS_EC2_METADATA_DISABLED: 'true' };
    const r = spawnSync(process.execPath, [path.join(dir, 'eks-token.js'), '--cluster', 'c', '--region', 'eu-west-1', '--profile', 'k8board-test-none'], { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^eks-token: /m);
    assert.doesNotMatch(r.stderr, MODULE_ERROR);
  });

  test('the Azure token helper and the MCP bridge load', async () => {
    const az = spawnSync(process.execPath, [path.join(dir, 'azure-token.js')], { encoding: 'utf8', timeout: 30000 });
    assert.match(az.stderr, /azure-token: /);
    assert.doesNotMatch(az.stderr, MODULE_ERROR);
    // The bridge waits for a client on stdin; it only has to load and stay up.
    const child = spawn(process.execPath, [path.join(dir, 'mcp-stdio.js')], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    const exited = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 2500);
      child.on('exit', (code) => { clearTimeout(t); resolve(code); });
    });
    child.kill();
    assert.doesNotMatch(err, MODULE_ERROR);
    if (exited !== null) assert.notEqual(exited, null);
  });
});
