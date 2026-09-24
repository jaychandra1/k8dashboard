// GET /api/deployments/:namespace/:name/pods — the pods behind a Deployment
// (for the deployment logs view). Runs the real server against a tiny
// in-process fake Kubernetes API, plus unit tests for labelSelectorFor.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { labelSelectorFor } from '../lib/k8s-ops.mjs';
import { startServer, freePort } from './helpers/server.mjs';

describe('labelSelectorFor', () => {
  test('joins matchLabels and matchExpressions the way kubectl -l spells them', () => {
    assert.equal(labelSelectorFor({ matchLabels: { app: 'web', tier: 'fe' } }), 'app=web,tier=fe');
    assert.equal(
      labelSelectorFor({
        matchLabels: { app: 'web' },
        matchExpressions: [
          { key: 'env', operator: 'In', values: ['qa', 'uat'] },
          { key: 'track', operator: 'NotIn', values: ['canary'] },
          { key: 'team', operator: 'Exists' },
          { key: 'legacy', operator: 'DoesNotExist' },
        ],
      }),
      'app=web,env in (qa,uat),track notin (canary),team,!legacy',
    );
  });

  test('an empty or missing selector is "" (callers must not list every pod)', () => {
    assert.equal(labelSelectorFor(undefined), '');
    assert.equal(labelSelectorFor({}), '');
    assert.equal(labelSelectorFor({ matchLabels: {} }), '');
  });
});

const pod = (name, labels, phase, created) => ({
  metadata: { name, namespace: 'shop', uid: `${name}-uid`, labels, creationTimestamp: created },
  spec: { nodeName: 'node-1', containers: [{ name: 'app' }, { name: 'sidecar' }] },
  status: { phase, containerStatuses: [] },
});
const PODS = [
  pod('web-7c8f-old', { app: 'web' }, 'Running', '2026-09-20T10:00:00Z'),
  pod('web-7c8f-pending', { app: 'web' }, 'Pending', '2026-09-24T10:00:00Z'),
  pod('web-7c8f-new', { app: 'web' }, 'Running', '2026-09-23T10:00:00Z'),
  pod('api-5d6e-aaa', { app: 'api' }, 'Running', '2026-09-22T10:00:00Z'),
];
const DEPLOYMENTS = {
  web: { metadata: { name: 'web', namespace: 'shop' }, spec: { selector: { matchLabels: { app: 'web' } } } },
  broken: { metadata: { name: 'broken', namespace: 'shop' }, spec: { selector: {} } },
};

describe('GET /api/deployments/:namespace/:name/pods', () => {
  let srv, fake, dir;
  const podListQueries = [];

  before(async () => {
    const fakePort = await freePort();
    fake = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://fake');
      const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      const dep = url.pathname.match(/^\/apis\/apps\/v1\/namespaces\/shop\/deployments\/([^/]+)$/);
      if (dep) {
        const d = DEPLOYMENTS[dep[1]];
        return d ? send(200, { apiVersion: 'apps/v1', kind: 'Deployment', ...d })
          : send(404, { kind: 'Status', status: 'Failure', reason: 'NotFound', code: 404, message: `deployments.apps "${dep[1]}" not found` });
      }
      if (url.pathname === '/api/v1/namespaces/shop/pods') {
        const selector = url.searchParams.get('labelSelector');
        podListQueries.push(selector);
        const want = Object.fromEntries((selector || '').split(',').filter(Boolean).map((kv) => kv.split('=')));
        const items = PODS.filter((p) => Object.entries(want).every(([k, v]) => p.metadata.labels[k] === v));
        return send(200, { kind: 'PodList', apiVersion: 'v1', metadata: {}, items });
      }
      return send(404, { kind: 'Status', status: 'Failure', reason: 'NotFound', code: 404, message: 'not found' });
    });
    await new Promise((r) => fake.listen(fakePort, '127.0.0.1', r));

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubepilot-deploy-pods-'));
    const kubeconfig = path.join(dir, 'config');
    fs.writeFileSync(kubeconfig, [
      'apiVersion: v1', 'kind: Config',
      'clusters:', '- name: c', '  cluster:', `    server: http://127.0.0.1:${fakePort}`, '    insecure-skip-tls-verify: true',
      'users:', '- name: u', '  user:', '    token: fake-token',
      'contexts:', '- name: ctx', '  context:', '    cluster: c', '    user: u',
      'current-context: ctx', '',
    ].join('\n'));
    srv = await startServer({ env: { KUBECONFIG: kubeconfig, KUBEPILOT_DEMO: '' } });
  });

  after(async () => {
    if (srv) await srv.stop();
    if (fake) await new Promise((r) => fake.close(r));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('lists only the pods its selector matches: Running first, newest first', async () => {
    const res = await srv.authed('/api/deployments/shop/web/pods');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.selector, 'app=web');
    assert.equal(body.total, 3);
    assert.deepEqual(body.pods.map((p) => p.name), ['web-7c8f-new', 'web-7c8f-old', 'web-7c8f-pending']);
    assert.deepEqual(body.pods[0].containerNames, ['app', 'sidecar']);
    assert.equal(body.pods[0].status, 'Running');
    assert.ok(podListQueries.includes('app=web'));
  });

  test('an empty selector yields no pods and never lists the whole namespace', async () => {
    const before = podListQueries.length;
    const res = await srv.authed('/api/deployments/shop/broken/pods');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { pods: [], total: 0, selector: '' });
    assert.equal(podListQueries.length, before);
  });

  test('a missing deployment is a 404', async () => {
    const res = await srv.authed('/api/deployments/shop/nope/pods');
    assert.equal(res.status, 404);
  });

  test('invalid namespace / name are rejected with 400 before any API call', async () => {
    assert.equal((await srv.authed('/api/deployments/-/web/pods')).status, 400);
    assert.equal((await srv.authed('/api/deployments/shop/Not_Valid/pods')).status, 400);
  });

  test('requires the bearer token', async () => {
    const res = await fetch(`${srv.base}/api/deployments/shop/web/pods`);
    assert.equal(res.status, 401);
  });
});
