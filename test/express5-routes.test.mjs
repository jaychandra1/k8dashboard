// Routes whose syntax or behaviour changed with Express 5, over HTTP against a
// fake API server:
//   GET /api/metrics/pods{/:namespace}  the namespace is optional
//   GET /{*splat}                       the UI for any non-API path, including /
//   POST with no body                   req.body is undefined in Express 5: a 400, not a crash
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ROOT, startServer } from './helpers/server.mjs';

const podMetrics = (namespace, name) => ({
  metadata: { namespace, name }, timestamp: '2026-11-06T09:00:00Z', window: '30s',
  containers: [{ name: 'app', usage: { cpu: '25m', memory: '64Mi' } }],
});

function fakeKubeApi(hits) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    hits.push(url.pathname);
    const json = (obj, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    switch (url.pathname) {
      case '/apis/metrics.k8s.io/v1beta1/pods':
        return json({ items: [podMetrics('shop', 'web-1'), podMetrics('ops', 'agent-1')] });
      case '/apis/metrics.k8s.io/v1beta1/namespaces/shop/pods':
        return json({ items: [podMetrics('shop', 'web-1')] });
      default:
        return json({ kind: 'Status', code: 404 }, 404);
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

describe('Express 5 routes', () => {
  let srv, kube, dir;
  const hits = [];
  before(async () => {
    kube = await fakeKubeApi(hits);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-express5-'));
    const kubeconfig = path.join(dir, 'config');
    fs.writeFileSync(kubeconfig, `apiVersion: v1
kind: Config
current-context: dev
clusters:
- name: dev
  cluster: { server: 'http://127.0.0.1:${kube.address().port}', insecure-skip-tls-verify: true }
users:
- name: dev
  user: { token: dev-token }
contexts:
- name: dev
  context: { cluster: dev, user: dev }
`);
    srv = await startServer({ env: { KUBEPILOT_DEMO: '', KUBECONFIG: kubeconfig } });
  });
  after(async () => {
    await srv?.stop();
    kube?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('pod metrics: every namespace without the segment, one namespace with it', async () => {
    const all = await srv.authed('/api/metrics/pods');
    assert.equal(all.status, 200);
    assert.deepEqual(Object.keys((await all.json()).metrics).sort(), ['ops/agent-1', 'shop/web-1']);
    assert.ok(hits.includes('/apis/metrics.k8s.io/v1beta1/pods'), hits.join(', '));

    const one = await srv.authed('/api/metrics/pods/shop');
    assert.equal(one.status, 200);
    assert.deepEqual(Object.keys((await one.json()).metrics), ['shop/web-1']);
    assert.ok(hits.includes('/apis/metrics.k8s.io/v1beta1/namespaces/shop/pods'), hits.join(', '));

    assert.equal((await srv.authed('/api/metrics/pods/Bad_NS')).status, 400);
  });

  test('the UI is served for / and for deep links; unknown API paths stay 404', async () => {
    const built = fs.existsSync(path.join(ROOT, 'client', 'dist', 'index.html'));
    const home = await srv.authed('/');
    const deep = await srv.authed('/security/images');
    if (built) {
      assert.equal(home.status, 200);
      assert.match(home.headers.get('content-type'), /text\/html/);
      assert.equal(deep.status, 200);
      assert.equal(await deep.text(), await home.text(), 'a deep link gets the same index.html');
    } else {
      // No client build (backend-only CI run): the fallback steps aside cleanly.
      assert.equal(deep.status, 404);
    }
    const api = await srv.authed('/api/no-such-route');
    assert.equal(api.status, 404);
    assert.doesNotMatch(await api.text(), /<!doctype html>/i);
  });

  test('a write with no request body is a 400, not a crash', async () => {
    const r = await srv.authed('/api/scale/shop/deployment/web', { method: 'POST' });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).field, 'replicas');
  });
});
