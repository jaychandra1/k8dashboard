// When a cluster's sign-in is over, its requests answer `cluster_auth_required`
// at once instead of each starting a failing credential helper, the helper's
// runtime noise never reaches the answer, and an explicit check (the UI's
// re-check, Retry) runs the helper again. A fake helper counts its runs.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';

const HELPER = `import fs from 'node:fs';
fs.appendFileSync(process.env.FAKE_HELPER_COUNT, 'x\\n');
await new Promise((r) => setTimeout(r, 300)); // slow enough for requests to pile up
process.stderr.write('[7996:1106/160352.881:ERROR:net\\\\disk_cache\\\\cache_util_win.cc:25] Unable to move the cache: Access is denied. (0x5)\\n');
process.stderr.write("k8board token-helper: The SSO session token associated with profile=sso-241533118296 was not found or is invalid. To refresh this SSO session run 'aws sso login' with the corresponding profile.\\n");
process.exit(1);
`;

describe('cluster sign-in gate', () => {
  let srv, dir, countFile;
  const runs = () => { try { return fs.readFileSync(countFile, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
  const get = async (p) => { const r = await srv.authed(p); return { status: r.status, body: await r.json() }; };

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-signin-gate-'));
    countFile = path.join(dir, 'runs.txt');
    const helper = path.join(dir, 'fake-sso-helper.mjs');
    fs.writeFileSync(helper, HELPER);
    fs.writeFileSync(path.join(dir, 'config'), [
      'apiVersion: v1', 'kind: Config', 'current-context: dev',
      'clusters:', '- name: dev', "  cluster: { server: 'https://127.0.0.1:9', insecure-skip-tls-verify: true }",
      'users:', '- name: dev', '  user:', '    exec:', '      apiVersion: client.authentication.k8s.io/v1beta1',
      `      command: ${JSON.stringify(process.execPath)}`, `      args: [${JSON.stringify(helper)}]`,
      `      env: [{ name: FAKE_HELPER_COUNT, value: ${JSON.stringify(countFile)} }]`,
      'contexts:', '- name: dev', '  context: { cluster: dev, user: dev }', '',
    ].join('\n'));
    srv = await startServer({ env: { KUBEPILOT_DEMO: '', KUBECONFIG: path.join(dir, 'config') } });
  });
  after(async () => {
    await srv?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a burst of requests runs the helper once and answers cluster_auth_required', async () => {
    const before = runs();
    const answers = await Promise.all(['/api/namespaces', '/api/namespaces', '/api/nodes', '/api/events'].map(get));
    for (const a of answers) {
      assert.equal(a.status, 424);
      assert.deepEqual([a.body.code, a.body.error], ['cluster_auth_required', 'Sign in again to use this cluster.']);
    }
    assert.equal(runs() - before, 1, 'one helper run for the whole burst');
  });

  test('later requests fail at once, with no helper run', async () => {
    const before = runs();
    const started = Date.now();
    const a = await get('/api/namespaces');
    assert.equal(a.status, 424);
    assert.equal(runs(), before);
    assert.ok(Date.now() - started < 250, 'no wait for a helper');
  });

  test('the auth check runs the helper again: an expired AWS sign-in, without runtime noise', async () => {
    const before = runs();
    const { body } = await get('/api/config/auth');
    assert.equal(runs() - before, 1);
    assert.deepEqual([body.ok, body.reason], [false, 'sso-expired']);
    assert.match(body.detail, /aws sso login/);
    assert.doesNotMatch(body.detail, /disk_cache|Access is denied/);
    // And it blocks again: the next request doesn't run it.
    await get('/api/namespaces');
    assert.equal(runs() - before, 1);
  });

  test('reloading the kubeconfig (after a sign-in, or Retry) lifts the block', async () => {
    const r = await srv.authed('/api/config/reload', { method: 'POST' });
    assert.equal(r.status, 200);
    const before = runs();
    assert.equal((await get('/api/namespaces')).status, 424);
    assert.equal(runs() - before, 1);
  });
});
