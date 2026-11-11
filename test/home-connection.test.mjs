// Startup connects to nothing; a passing auth check is the connection.
// GET /api/config/status reports it (connected, lastConnected, recent,
// local sign-in hints), POST /api/config/disconnect ends it, and
// nothing reaches a cluster until the UI asks. A tiny fake Kubernetes API
// counts what reaches it.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';

describe('Home: connecting on request only', () => {
  let srv, api, dir, hits = 0;
  const json = async (p, init) => {
    const r = await srv.authed(p, init);
    return { status: r.status, body: await r.json() };
  };
  const post = (p, body, headers = {}) => json(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) });
  const status = async () => (await json('/api/config/status')).body;

  before(async () => {
    api = http.createServer((req, res) => {
      hits += 1;
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/api/v1/namespaces')) return res.end(JSON.stringify({ kind: 'NamespaceList', apiVersion: 'v1', metadata: {}, items: [] }));
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise((r) => api.listen(0, '127.0.0.1', r));
    const server = `http://127.0.0.1:${api.address().port}`;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-home-'));
    const exec = (name, profile) => `- name: ${name}\n  user:\n    exec:\n      apiVersion: client.authentication.k8s.io/v1beta1\n      command: node\n      args: [eks-token.js, --token-helper, eks, --cluster, ${name}, --region, eu-west-1, --profile, ${profile}]`;
    fs.writeFileSync(path.join(dir, 'config'), [
      'apiVersion: v1', 'kind: Config', 'current-context: dev',
      // Plain http needs insecure-skip-tls-verify for @kubernetes/client-node.
      'clusters:', `- name: fake\n  cluster: { server: '${server}', insecure-skip-tls-verify: true }`, "- name: eks\n  cluster: { server: 'https://127.0.0.1:9' }",
      'users:', '- name: tok\n  user: { token: test-token }', exec('eks-signed-in', 'in'), exec('eks-expired', 'old'),
      'contexts:',
      '- name: dev\n  context: { cluster: fake, user: tok }',
      '- name: other\n  context: { cluster: fake, user: tok }',
      '- name: eks-signed-in\n  context: { cluster: eks, user: eks-signed-in }',
      '- name: eks-expired\n  context: { cluster: eks, user: eks-expired }', '',
    ].join('\n'));
    srv = await startServer({ env: { KUBEPILOT_DEMO: '', KUBECONFIG: path.join(dir, 'config') } });
    // AWS sign-ins for the hints: one valid token, one expired (local files only).
    const aws = path.join(srv.home, '.aws');
    fs.mkdirSync(path.join(aws, 'sso', 'cache'), { recursive: true });
    fs.writeFileSync(path.join(aws, 'config'), [
      '[sso-session s1]', 'sso_start_url = https://d-1111111111.awsapps.com/start', 'sso_region = us-east-1', '',
      '[sso-session s2-production]', 'sso_start_url = https://d-1111111111.awsapps.com/start', 'sso_region = us-east-1', '',
      '[profile in]', 'sso_session = s1', 'sso_account_id = 111122223333', 'sso_role_name = Dev', '',
      '[profile old]', 'sso_session = s2-production', 'sso_account_id = 444455556666', 'sso_role_name = Admin', '',
    ].join('\n'));
    const tok = (name, ms) => fs.writeFileSync(path.join(aws, 'sso', 'cache', `${crypto.createHash('sha1').update(name).digest('hex')}.json`), JSON.stringify({ startUrl: 'x', region: 'us-east-1', accessToken: 'a', expiresAt: new Date(Date.now() + ms).toISOString() }));
    tok('s1', 3600e3);
    tok('s2-production', -3600e3);
  });
  after(async () => {
    await srv?.stop();
    await new Promise((r) => api?.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('startup: the clusters are listed, nothing is connected, nothing reached a cluster', async () => {
    const s = await status();
    assert.deepEqual([s.loaded, s.connected, s.lastConnected, s.recent], [true, false, null, []]);
    assert.deepEqual(s.contexts, ['dev', 'other', 'eks-signed-in', 'eks-expired']);
    assert.equal(hits, 0);
  });

  test('sign-in hints come from the local token cache', async () => {
    const info = Object.fromEntries((await status()).contextsInfo.map((c) => [c.name, c.signIn || null]));
    assert.deepEqual(info['eks-signed-in'], { kind: 'aws', state: 'signed-in' });
    assert.deepEqual(info['eks-expired'], { kind: 'aws', state: 'expired' });
    assert.equal(info.dev, null);
    assert.equal(hits, 0, 'still nothing sent to a cluster');
  });

  test('a passing auth check is the connection, and is remembered', async () => {
    const auth = (await json('/api/config/auth')).body;
    assert.equal(auth.ok, true);
    assert.ok(hits > 0);
    const s = await status();
    assert.deepEqual([s.connected, s.lastConnected, s.recent.map((r) => r.name)], [true, 'dev', ['dev']]);
  });

  test('selecting another cluster is not connecting to it; its auth check is', async () => {
    assert.equal((await post('/api/config/context', { contextName: 'other' })).status, 200);
    assert.equal((await status()).connected, false);
    assert.equal((await json('/api/config/auth')).body.ok, true);
    const s = await status();
    assert.deepEqual([s.connected, s.lastConnected, s.recent.map((r) => r.name)], [true, 'other', ['other', 'dev']]);
  });

  test('Disconnect ends it (not for AI agents)', async () => {
    assert.equal((await post('/api/config/disconnect', {}, { 'X-K8Board-Source': 'mcp' })).status, 403);
    assert.equal((await status()).connected, true);
    const r = await post('/api/config/disconnect');
    assert.deepEqual([r.status, r.body.connected], [200, false]);
    const s = await status();
    assert.deepEqual([s.connected, s.lastConnected], [false, 'other'], 'still remembered for Home');
  });

  test('there is no connect-at-startup setting: no endpoint, nothing in the status', async () => {
    const r = await json('/api/settings/startup', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoConnect: true }) });
    assert.equal(r.status, 404);
    assert.equal('autoConnect' in (await status()), false);
  });

  test('a removed cluster leaves the recent list', async () => {
    const r = await post('/api/config/contexts/remove', { context: 'other' });
    assert.equal(r.status, 200);
    const s = await status();
    assert.deepEqual([s.lastConnected, s.recent.map((x) => x.name)], ['dev', ['dev']]);
  });
});
