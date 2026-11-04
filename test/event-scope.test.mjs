// Events filters (lib/event-scope.mjs + GET /api/events): a workload's events
// include those of what it owns — also the ReplicaSets / Pods a rollout
// already deleted — and type / search / namespaces filter before paging.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { workloadScope, inScope, filterEvents, parseWorkload } from '../lib/event-scope.mjs';
import { startServer } from './helpers/server.mjs';

const owned = (kind, name, ownerKind, ownerName, extra = {}) => ({ kind, metadata: { name, namespace: 'shop', ownerReferences: ownerKind ? [{ kind: ownerKind, name: ownerName, controller: true }] : [] }, ...extra });

describe('workload scope', () => {
  const replicaSets = [owned('ReplicaSet', 'web-7f9c6d5b4', 'Deployment', 'web'), owned('ReplicaSet', 'web-api-55d8c', 'Deployment', 'web-api')];
  const pods = [
    owned('Pod', 'web-7f9c6d5b4-x2k9p', 'ReplicaSet', 'web-7f9c6d5b4'),
    owned('Pod', 'web-api-55d8c-q7r4t', 'ReplicaSet', 'web-api-55d8c'),
    owned('Pod', 'db-0', 'StatefulSet', 'db'),
    owned('Pod', 'backup-29000000-k8s2z', 'Job', 'backup-29000000'),
  ];
  const jobs = [owned('Job', 'backup-29000000', 'CronJob', 'backup')];
  const hpas = [{ metadata: { name: 'web' }, spec: { scaleTargetRef: { kind: 'Deployment', name: 'web' } } }];

  test('Deployment: itself, its ReplicaSets and their Pods, its autoscaler — and deleted ones by generated name', () => {
    const s = workloadScope({ kind: 'Deployment', name: 'web' }, { replicaSets, pods, hpas });
    assert.ok(inScope(s, 'Deployment', 'web'));
    assert.ok(inScope(s, 'ReplicaSet', 'web-7f9c6d5b4'));
    assert.ok(inScope(s, 'Pod', 'web-7f9c6d5b4-x2k9p'));
    assert.ok(inScope(s, 'HorizontalPodAutoscaler', 'web'));
    // A previous revision whose ReplicaSet / Pods are gone.
    assert.ok(inScope(s, 'ReplicaSet', 'web-5c4d8b6f9'));
    assert.ok(inScope(s, 'Pod', 'web-5c4d8b6f9-zz2bq'));
    // Another Deployment whose name starts with "web-" is not in it.
    assert.ok(!inScope(s, 'ReplicaSet', 'web-api-55d8c'));
    assert.ok(!inScope(s, 'Pod', 'web-api-55d8c-q7r4t'));
    assert.ok(!inScope(s, 'Deployment', 'web-api'));
  });

  test('StatefulSet, CronJob, Job, DaemonSet and Pod', () => {
    const sts = workloadScope({ kind: 'StatefulSet', name: 'db' }, { pods });
    assert.ok(inScope(sts, 'Pod', 'db-0') && inScope(sts, 'Pod', 'db-3') && inScope(sts, 'PersistentVolumeClaim', 'data-db-0'));
    assert.ok(!inScope(sts, 'Pod', 'db-migrate-1'));
    const cj = workloadScope({ kind: 'CronJob', name: 'backup' }, { jobs, pods });
    assert.ok(inScope(cj, 'Job', 'backup-29000000') && inScope(cj, 'Pod', 'backup-29000000-k8s2z'));
    assert.ok(inScope(cj, 'Job', 'backup-28999940'), 'an earlier run');
    const job = workloadScope({ kind: 'Job', name: 'migrate' }, { pods: [owned('Pod', 'migrate-b7x2q', 'Job', 'migrate')] });
    assert.ok(inScope(job, 'Pod', 'migrate-b7x2q') && inScope(job, 'Pod', 'migrate-zzzzz'));
    const ds = workloadScope({ kind: 'DaemonSet', name: 'agent' }, { pods: [] });
    assert.ok(inScope(ds, 'Pod', 'agent-x7k2p') && !inScope(ds, 'Pod', 'agent-config'));
    const pod = workloadScope({ kind: 'Pod', name: 'web-7f9c6d5b4-x2k9p' }, {});
    assert.ok(inScope(pod, 'Pod', 'web-7f9c6d5b4-x2k9p') && !inScope(pod, 'ReplicaSet', 'web-7f9c6d5b4'));
  });

  test('workload parameter: a scope kind and a valid name only', () => {
    assert.deepEqual(parseWorkload('Deployment/frontend'), { kind: 'Deployment', name: 'frontend' });
    assert.equal(parseWorkload('Secret/x'), null);
    assert.equal(parseWorkload('Deployment/Bad_Name'), null);
    assert.equal(parseWorkload('Deployment'), null);
  });

  test('type, search and namespaces filter', () => {
    const ev = [
      { type: 'Warning', reason: 'BackOff', message: 'Back-off restarting', namespace: 'shop', involvedObject: 'Pod/web-1', source: 'kubelet' },
      { type: 'Normal', reason: 'Pulled', message: 'image pulled', namespace: 'ops', involvedObject: 'Pod/agent-1', source: 'kubelet' },
    ];
    assert.equal(filterEvents(ev, { type: 'Warning' }).length, 1);
    assert.equal(filterEvents(ev, { q: 'AGENT' })[0].namespace, 'ops');
    assert.equal(filterEvents(ev, { q: 'backoff' }).length, 1);
    assert.equal(filterEvents(ev, { namespaces: ['ops'] }).length, 1);
    assert.equal(filterEvents(ev, {}).length, 2);
  });
});

// ---------------------------------------------------------------------------
const ev = (ns, type, reason, kind, name, message, minutesAgo) => ({
  metadata: { namespace: ns, name: `${name}.${reason}` }, type, reason, message,
  involvedObject: { kind, name, namespace: ns }, source: { component: 'kubelet' },
  count: 1, lastTimestamp: new Date(Date.now() - minutesAgo * 60000).toISOString(),
});
const EVENTS = [
  ev('shop', 'Normal', 'ScalingReplicaSet', 'Deployment', 'web', 'Scaled up replica set web-7f9c6d5b4 to 2', 30),
  ev('shop', 'Normal', 'SuccessfulCreate', 'ReplicaSet', 'web-7f9c6d5b4', 'Created pod: web-7f9c6d5b4-x2k9p', 29),
  ev('shop', 'Warning', 'BackOff', 'Pod', 'web-7f9c6d5b4-x2k9p', 'Back-off restarting failed container', 2),
  ev('shop', 'Warning', 'Unhealthy', 'Pod', 'web-5c4d8b6f9-zz2bq', 'Readiness probe failed (old revision)', 40),
  ev('shop', 'Normal', 'Pulled', 'Pod', 'web-api-55d8c-q7r4t', 'Successfully pulled image', 5),
  ev('shop', 'Warning', 'FailedScheduling', 'Pod', 'db-0', '0/3 nodes are available', 1),
];
const list = (items) => ({ metadata: {}, items });

function fakeKubeApi() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (obj, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    switch (url.pathname) {
      case '/api/v1/namespaces/shop/events': return json(list(EVENTS));
      case '/api/v1/events': return json(list([...EVENTS, ev('ops', 'Normal', 'Pulled', 'Pod', 'agent-x7k2p', 'pulled', 3)]));
      case '/apis/apps/v1/namespaces/shop/replicasets': return json(list([owned('ReplicaSet', 'web-7f9c6d5b4', 'Deployment', 'web'), owned('ReplicaSet', 'web-api-55d8c', 'Deployment', 'web-api')]));
      case '/api/v1/namespaces/shop/pods': return json(list([owned('Pod', 'web-7f9c6d5b4-x2k9p', 'ReplicaSet', 'web-7f9c6d5b4'), owned('Pod', 'web-api-55d8c-q7r4t', 'ReplicaSet', 'web-api-55d8c'), owned('Pod', 'db-0', 'StatefulSet', 'db')]));
      case '/apis/autoscaling/v2/namespaces/shop/horizontalpodautoscalers': return json(list([]));
      default: return json({ kind: 'Status', code: 404, message: 'not found' }, 404);
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

describe('GET /api/events filters (fake cluster)', () => {
  let srv, kube, dir;
  before(async () => {
    kube = await fakeKubeApi();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-events-'));
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

  const get = async (q) => (await srv.authed(`/api/events/${q}`)).json();

  test('a Deployment: its own, its ReplicaSet and Pod events, and the old revision — not web-api or db', async () => {
    const r = await get('shop?workload=Deployment/web');
    assert.deepEqual(r.events.map((e) => e.involvedObject), [
      'Pod/web-7f9c6d5b4-x2k9p', 'ReplicaSet/web-7f9c6d5b4', 'Deployment/web', 'Pod/web-5c4d8b6f9-zz2bq',
    ]);
    assert.equal(r.pagination.total, 4);
    assert.equal(r.unfiltered, 6);
    assert.equal(r.workload, 'Deployment/web');
  });

  test('Warnings only, search, and several namespaces — before paging', async () => {
    const w = await get('shop?type=Warning&limit=2');
    assert.equal(w.pagination.total, 3);
    assert.equal(w.events.length, 2);
    assert.ok(w.events.every((e) => e.type === 'Warning'));
    const s = await get('shop?q=readiness');
    assert.deepEqual(s.events.map((e) => e.reason), ['Unhealthy']);
    const both = await get('all?workload=');
    assert.equal(both.pagination.total, 7);
    const ops = await get('all?namespaces=ops');
    assert.deepEqual(ops.events.map((e) => e.namespace), ['ops']);
  });

  test('bad filters are refused', async () => {
    assert.equal((await srv.authed('/api/events/shop?workload=Secret/x')).status, 400);
    assert.equal((await srv.authed('/api/events/all?workload=Deployment/web')).status, 400, 'needs a namespace');
    assert.equal((await srv.authed('/api/events/shop?type=Error')).status, 400);
    assert.equal((await srv.authed(`/api/events/shop?q=${'x'.repeat(201)}`)).status, 400);
  });
});

describe('demo mode: checkout’s events', () => {
  let srv;
  before(async () => { srv = await startServer({ env: { KUBEPILOT_DEMO: '1' } }); });
  after(async () => { await srv?.stop(); });

  test('Deployment checkout → its ReplicaSet and Pods', async () => {
    await srv.authed('/api/config/context', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contextName: 'demo-cluster' }) });
    const r = await (await srv.authed('/api/events/shop?workload=Deployment/checkout')).json();
    const objects = new Set(r.events.map((e) => e.involvedObject.split('/')[0]));
    assert.deepEqual([...objects].sort(), ['Deployment', 'Pod', 'ReplicaSet']);
    assert.ok(r.events.every((e) => /checkout/.test(e.involvedObject)), JSON.stringify(r.events.map((e) => e.involvedObject)));
    const warnings = await (await srv.authed('/api/events/all?type=Warning')).json();
    assert.ok(warnings.events.length > 0 && warnings.events.every((e) => e.type === 'Warning'));
  });
});
