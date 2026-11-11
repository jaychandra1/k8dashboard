// The response cache (lib/cache.mjs) and what a change invalidates. A change
// to something in one namespace refetches that namespace and every
// cluster-wide view, and leaves other namespaces' cached lists alone: in "All
// namespaces" the UI asks for each namespace separately, so flushing the whole
// cache made every scale / restart / delete re-list every namespace. A tiny
// fake Kubernetes API counts what reaches the cluster.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createCache } from '../lib/cache.mjs';
import { startServer } from './helpers/server.mjs';

describe('cache', () => {
  test('keys carry the context; entries expire; a write for another context is dropped', async () => {
    let ctx = 'dev';
    const cache = createCache({ getContext: () => ctx, sweepMs: 3_600_000 });
    const k = cache.key('resources', { namespace: 'a' });
    assert.equal(cache.set(k, { pods: [] }, 1000), true);
    assert.deepEqual(cache.get(k), { pods: [] });
    assert.equal(cache.get(cache.key('resources', { namespace: 'b' })), null);
    ctx = 'prod';
    assert.equal(cache.get(cache.key('resources', { namespace: 'a' })), null, 'another cluster never sees it');
    assert.equal(cache.set(k, { pods: ['late'] }, 1000), false, 'a fetch that began before the switch is not stored');
    ctx = 'dev';
    assert.equal(cache.set(cache.key('logs', { namespace: 'a' }), 'x', 1), true);
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(cache.get(cache.key('logs', { namespace: 'a' })), null, 'expired');
    cache.stop();
  });

  test('invalidate keeps only what the caller vouches for; anything unreadable or of another context goes', () => {
    let ctx = 'dev';
    const cache = createCache({ getContext: () => ctx, sweepMs: 3_600_000 });
    const put = (prefix, params) => { const k = cache.key(prefix, params); cache.set(k, { prefix, params }, 60_000); return k; };
    const a = put('resources', { namespace: 'a' });
    const b = put('resources', { namespace: 'b' });
    const summary = put('cluster-summary');
    const nodes = put('nodes');
    const odd = `${JSON.stringify('dev')} not-a-key`;
    cache.set(odd, 1, 60_000);
    ctx = 'prod';
    const other = put('resources', { namespace: 'b' });
    ctx = 'dev';
    const seen = [];
    cache.invalidate((prefix, params) => { seen.push([prefix, params]); return prefix === 'resources' && params.namespace === 'b'; });
    assert.deepEqual(seen, [['resources', { namespace: 'a' }], ['resources', { namespace: 'b' }], ['cluster-summary', undefined], ['nodes', undefined]]);
    assert.deepEqual([a, b, summary, nodes, odd].map((k) => cache.get(k) !== null), [false, true, false, false, false]);
    ctx = 'prod';
    assert.equal(cache.get(other), null, 'entries of another context are dropped too');
    ctx = 'dev';
    assert.deepEqual(cache.stats().entries, 1);
    // A predicate that throws keeps nothing.
    put('resources', { namespace: 'c' });
    cache.invalidate(() => { throw new Error('boom'); });
    assert.equal(cache.stats().entries, 0);
    cache.stop();
  });
});

describe('what a change refetches', () => {
  let srv, api, dir;
  const calls = []; // [method, path] of every request that reached the cluster
  const listsOf = (ns) => calls.filter(([m, p]) => m === 'GET' && p.includes(`/namespaces/${ns}/`)).length;
  const get = async (p) => { const r = await srv.authed(p); await r.text(); return { status: r.status, hit: r.headers.get('x-cache') === 'HIT' }; };
  const send = async (method, p, body) => {
    const r = await srv.authed(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  before(async () => {
    api = http.createServer((req, res) => {
      const url = req.url.split('?')[0];
      calls.push([req.method, url]);
      res.setHeader('Content-Type', 'application/json');
      req.resume();
      req.on('end', () => {
        if (req.method === 'PATCH' && url.endsWith('/scale')) return res.end(JSON.stringify({ kind: 'Scale', apiVersion: 'autoscaling/v1', metadata: { name: 'web' }, spec: { replicas: 2 } }));
        if (req.method === 'PATCH') return res.end(JSON.stringify({ kind: 'Deployment', apiVersion: 'apps/v1', metadata: { name: 'web' } }));
        if (req.method === 'DELETE') return res.end(JSON.stringify({ kind: 'Status', apiVersion: 'v1', status: 'Success' }));
        res.end(JSON.stringify({ kind: 'List', apiVersion: 'v1', metadata: {}, items: [] }));
      });
    });
    await new Promise((r) => api.listen(0, '127.0.0.1', r));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-cache-'));
    fs.writeFileSync(path.join(dir, 'config'), [
      'apiVersion: v1', 'kind: Config', 'current-context: dev',
      'clusters:', `- name: fake\n  cluster: { server: 'http://127.0.0.1:${api.address().port}', insecure-skip-tls-verify: true }`,
      'users:', '- name: tok\n  user: { token: test-token }',
      'contexts:', '- name: dev\n  context: { cluster: fake, user: tok }', '',
    ].join('\n'));
    srv = await startServer({ env: { KUBEPILOT_DEMO: '', KUBECONFIG: path.join(dir, 'config'), KUBEPILOT_KUBECTL_BIN: '/nonexistent/kubectl' } });
    const auth = await srv.authed('/api/config/auth');
    assert.equal((await auth.json()).ok, true);
  });
  after(async () => {
    await srv?.stop();
    await new Promise((r) => api?.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('scaling a workload in one namespace refetches that namespace only', async () => {
    for (const ns of ['shop', 'billing', 'ops']) assert.deepEqual(await get(`/api/resources/${ns}`), { status: 200, hit: false });
    for (const ns of ['shop', 'billing', 'ops']) assert.equal((await get(`/api/resources/${ns}`)).hit, true, `${ns} is cached`);
    const perNamespace = listsOf('shop');
    assert.ok(perNamespace >= 5, `a namespace costs ${perNamespace} list calls`);

    const scaled = await send('POST', '/api/scale/shop/deployment/web', { replicas: 2 });
    assert.equal(scaled.status, 200, JSON.stringify(scaled.body));
    const before = { shop: listsOf('shop'), billing: listsOf('billing'), ops: listsOf('ops') };
    // What the UI does next in "All namespaces": ask for every namespace again.
    assert.deepEqual(
      [await get('/api/resources/shop'), await get('/api/resources/billing'), await get('/api/resources/ops')].map((r) => r.hit),
      [false, true, true]
    );
    assert.equal(listsOf('shop') - before.shop, perNamespace, 'the changed namespace was listed again');
    assert.deepEqual([listsOf('billing') - before.billing, listsOf('ops') - before.ops], [0, 0], 'nothing was asked of the cluster for the others');
  });

  test('restart and delete in a namespace behave the same', async () => {
    assert.equal((await send('POST', '/api/restart/billing/deployment/web')).status, 200);
    assert.deepEqual([(await get('/api/resources/billing')).hit, (await get('/api/resources/ops')).hit], [false, true]);
    assert.equal((await send('DELETE', '/api/resource/ops/pod/web-1')).status, 200);
    assert.deepEqual([(await get('/api/resources/ops')).hit, (await get('/api/resources/billing')).hit], [false, true]);
  });

  test('a cluster-scoped change, and a change of cluster, still refetch everything', async () => {
    for (const ns of ['shop', 'billing']) await get(`/api/resources/${ns}`);
    assert.equal((await send('DELETE', '/api/resource/-/namespace/old-team')).status, 200);
    assert.deepEqual([(await get('/api/resources/shop')).hit, (await get('/api/resources/billing')).hit], [false, false]);
    assert.equal((await get('/api/resources/shop')).hit, true);
    assert.equal((await send('POST', '/api/config/reload')).status, 200);
    assert.equal((await srv.authed('/api/config/auth').then((r) => r.json())).ok, true);
    assert.equal((await get('/api/resources/shop')).hit, false);
  });
});
