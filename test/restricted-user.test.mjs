// A user who was given a Role in one namespace and nothing cluster-wide (the
// "QA may read pods and restart deployments in qaenv" setup) can work in
// K8Board: the namespace they name is theirs to pick, what the Role allows
// works, and what it doesn't is answered "no access" in plain words — never an
// error dump, and never with the identity the API puts in its refusal.
// The cluster is a stand-in that enforces the Role (test/helpers/rbac-cluster.mjs).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';
import { startRbacCluster, kubeconfigFor, QA_USER } from './helpers/rbac-cluster.mjs';

async function setup({ cluster: clusterOptions, kubeconfig: kubeconfigOptions } = {}) {
  const cluster = await startRbacCluster(clusterOptions);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-restricted-'));
  const kubeconfig = path.join(dir, 'config');
  fs.writeFileSync(kubeconfig, kubeconfigFor(cluster.url, kubeconfigOptions));
  const srv = await startServer({ env: { KUBEPILOT_DEMO: '', KUBECONFIG: kubeconfig } });
  const call = async (p, init = {}) => {
    const r = await srv.authed(p, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}) }, body: init.body ? JSON.stringify(init.body) : undefined });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body, text };
  };
  const stop = async () => { await srv.stop(); await cluster.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { cluster, srv, call, stop };
}
const settingsOf = (srv) => JSON.parse(fs.readFileSync(path.join(srv.home, '.config', 'kubepilot', 'settings.json'), 'utf8'));
// What must never reach the UI: the identity in the API's refusals, and the client's dump of a response.
const assertClean = (text, where) => {
  assert.doesNotMatch(text, new RegExp(QA_USER), `${where}: the user's identity`);
  assert.doesNotMatch(text, /HTTP-Code|Unknown API Status Code|Headers:|\\"kind\\"/, `${where}: a response dump`);
};

describe('a Role in one namespace: connecting and finding the namespace', () => {
  let t;
  before(async () => { t = await setup(); });
  after(async () => { await t?.stop(); });

  test('the sign-in is good: connected, with limited permissions', async () => {
    const { body } = await t.call('/api/config/auth');
    assert.deepEqual([body.ok, body.authenticated, body.limited], [true, true, true]);
  });

  test('namespaces: not an error — none yet, and the UI is told the user may not list them', async () => {
    const r = await t.call('/api/namespaces');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { namespaces: [], details: [], restricted: true });
  });

  test('the Dashboard: "limited" instead of a failed summary', async () => {
    const r = await t.call('/api/cluster/summary');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { currentContext: 'qa-eks', serverVersion: 'v1.33.4-eks-fake', platform: 'linux/amd64', limited: true });
  });

  test('adding a namespace: only a real name, and only one the user has something in', async () => {
    // One name a request: the form sends one request per name typed.
    for (const name of ['', 'Bad_Name', '-qa', 'qa-', 'a'.repeat(64), 'qa env', 'qaenv,stage', 'qaenv, stage', '../etc', 42]) {
      const r = await t.call('/api/namespaces/known', { method: 'POST', body: { name } });
      assert.deepEqual([r.status, r.body.code, r.body.field], [400, 'invalid_param', 'name'], JSON.stringify(name));
    }
    // Another team's namespace, and one that doesn't exist: no access either way (a typo never ends up in the list).
    for (const name of ['prodenv', 'kube-system', 'qaenvv']) {
      const r = await t.call('/api/namespaces/known', { method: 'POST', body: { name } });
      assert.deepEqual([r.status, r.body.code], [403, 'no_access'], name);
      assert.match(r.body.error, new RegExp(`no access to a namespace named "${name}"`));
      assertClean(r.text, name);
    }
    assert.deepEqual((await t.call('/api/namespaces')).body.namespaces, []);
  });

  test('…their own is checked against the cluster, remembered for this cluster, and listed from then on', async () => {
    const r = await t.call('/api/namespaces/known', { method: 'POST', body: { name: ' qaenv ' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { namespaces: ['qaenv'], added: 'qaenv', verified: true, canList: ['configmaps', 'deployments.apps', 'pods', 'replicasets.apps', 'secrets'] });
    // Asked of the cluster with the one request every signed-in user may make.
    const review = t.cluster.requests.filter((q) => q.path.endsWith('/selfsubjectrulesreviews')).at(-1);
    assert.deepEqual([review.method, review.body.spec], ['POST', { namespace: 'qaenv' }]);
    assert.deepEqual(settingsOf(t.srv).knownNamespaces, [{ context: 'qa-eks', namespaces: ['qaenv'] }]);
    assert.deepEqual((await t.call('/api/namespaces')).body, {
      namespaces: ['qaenv'], details: [{ name: 'qaenv', status: 'Active', createdAt: null, labels: {} }], restricted: true,
    });
    // Twice is once.
    await t.call('/api/namespaces/known', { method: 'POST', body: { name: 'qaenv' } });
    assert.deepEqual(settingsOf(t.srv).knownNamespaces, [{ context: 'qa-eks', namespaces: ['qaenv'] }]);
  });

  test('an AI agent (MCP) cannot change that list', async () => {
    const mcp = { 'X-K8Board-Source': 'mcp' };
    const add = await t.call('/api/namespaces/known', { method: 'POST', body: { name: 'qaenv' }, headers: mcp });
    assert.deepEqual([add.status, add.body.code], [403, 'mcp_forbidden']);
    const remove = await t.call('/api/namespaces/known/qaenv', { method: 'DELETE', headers: mcp });
    assert.deepEqual([remove.status, remove.body.code], [403, 'mcp_forbidden']);
    assert.deepEqual((await t.call('/api/namespaces', { headers: mcp })).body.namespaces, ['qaenv']);
  });
});

describe('a Role in one namespace: what it allows works', () => {
  let t;
  before(async () => {
    t = await setup();
    await t.call('/api/namespaces/known', { method: 'POST', body: { name: 'qaenv' } });
  });
  after(async () => { await t?.stop(); });

  test('the lists: the five kinds of the Role; every other kind is "not allowed", not a failure', async () => {
    const r = await t.call('/api/resources/qaenv');
    assert.equal(r.status, 200);
    const count = Object.fromEntries(Object.entries(r.body).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]));
    assert.deepEqual(
      [count.pods, count.deployments, count.replicaSets, count.configMaps, count.secrets, count.services, count.statefulSets],
      [3, 2, 2, 2, 1, 0, 0],
    );
    assert.equal(r.body.partial, true);
    assert.deepEqual(r.body.errors.map((e) => e.kind).sort(), [
      'cronJobs', 'daemonSets', 'ingresses', 'jobs', 'networkPolicies', 'persistentVolumeClaims', 'replicationControllers', 'serviceAccounts', 'services', 'statefulSets',
    ]);
    for (const e of r.body.errors) assert.deepEqual([e.forbidden, e.error], [true, 'no permission'], e.kind);
    assertClean(r.text, 'resources');
    // The Service that is in qaenv but not in the Role is not shown.
    assert.doesNotMatch(r.text, /172\.20\.0\.10/);
  });

  test('pod logs, a Secret and a ConfigMap can be read', async () => {
    const logs = await t.call('/api/logs/qaenv/orders-api-7c9d8f6b5-2xk4p');
    assert.equal(logs.status, 200);
    assert.match(JSON.stringify(logs.body), /listening on :8080/);
    const secret = await t.call('/api/resource/qaenv/secret/orders-api-db');
    assert.equal(secret.status, 200);
    assert.match(secret.text, /orders-api-db/);
    const cm = await t.call('/api/resource/qaenv/configMap/orders-api-config');
    assert.equal(cm.status, 200);
    assert.match(cm.text, /LOG_LEVEL/);
  });

  test('restart: one PATCH of the restartedAt annotation, as `kubectl rollout restart` sends it', async () => {
    const before = t.cluster.requests.length;
    const r = await t.call('/api/restart/qaenv/deployment/orders-api', { method: 'POST' });
    assert.deepEqual([r.status, r.body.success], [200, true]);
    const writes = t.cluster.requests.slice(before).filter((q) => q.method !== 'GET');
    assert.equal(writes.length, 1);
    const [patch] = writes;
    assert.deepEqual([patch.method, patch.path, patch.status], ['PATCH', '/apis/apps/v1/namespaces/qaenv/deployments/orders-api', 200]);
    assert.match(patch.contentType, /strategic-merge-patch\+json/);
    // Nothing but the annotation: an admission policy that allows only a restart lets it through.
    assert.deepEqual(Object.keys(patch.body), ['spec']);
    assert.deepEqual(Object.keys(patch.body.spec.template.metadata.annotations), ['kubectl.kubernetes.io/restartedAt']);
    assert.ok(!Number.isNaN(Date.parse(patch.body.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'])));
  });
});

describe('a Role in one namespace: what it does not allow is said plainly', () => {
  let t;
  before(async () => {
    t = await setup();
    await t.call('/api/namespaces/known', { method: 'POST', body: { name: 'qaenv' } });
  });
  after(async () => { await t?.stop(); });

  test('reading: another namespace, nodes, events — 403 "forbidden" with what was refused', async () => {
    const cases = [
      ['/api/resources/prodenv', "You don't have permission to list pods in namespace prodenv.", { verb: 'list', resource: 'pods', group: '', namespace: 'prodenv' }],
      ['/api/nodes', "You don't have permission to list nodes.", { verb: 'list', resource: 'nodes', group: '', namespace: '' }],
      ['/api/events/qaenv', "You don't have permission to list events in namespace qaenv.", { verb: 'list', resource: 'events', group: '', namespace: 'qaenv' }],
      ['/api/resource/prodenv/secret/orders-api-db', "You don't have permission to view secrets in namespace prodenv.", { verb: 'get', resource: 'secrets', group: '', namespace: 'prodenv' }],
    ];
    for (const [p, error, denied] of cases) {
      const r = await t.call(p);
      assert.deepEqual([r.status, r.body.code, r.body.error], [403, 'forbidden', error], p);
      assert.deepEqual(r.body.denied, denied, p);
      assertClean(r.text, p);
      assert.doesNotMatch(r.text, /PRODUCTION-PASSWORD/);
    }
  });

  test('changing: scale, delete and another namespace\'s restart are refused, in the same words', async () => {
    const scale = await t.call('/api/scale/qaenv/deployment/orders-api', { method: 'POST', body: { replicas: 5 } });
    assert.deepEqual([scale.status, scale.body.code, scale.body.error], [403, 'forbidden', "You don't have permission to scale deployments in namespace qaenv."]);
    const del = await t.call('/api/resource/qaenv/pod/orders-api-7c9d8f6b5-2xk4p', { method: 'DELETE' });
    assert.deepEqual([del.status, del.body.code, del.body.error], [403, 'forbidden', "You don't have permission to delete pods in namespace qaenv."]);
    const restart = await t.call('/api/restart/prodenv/deployment/orders-api', { method: 'POST' });
    assert.deepEqual([restart.status, restart.body.error], [403, "You don't have permission to change deployments in namespace prodenv."]);
    for (const r of [scale, del, restart]) assertClean(r.text, 'write');
    // Nothing was changed in the cluster.
    assert.deepEqual(t.cluster.requests.filter((q) => q.method !== 'GET' && q.method !== 'POST' && q.status < 300), []);
    assert.equal(t.cluster.objects.get('|pods|qaenv').length, 3);
  });

  test('a namespace can be taken off the list again', async () => {
    const r = await t.call('/api/namespaces/known/qaenv', { method: 'DELETE' });
    assert.deepEqual([r.status, r.body], [200, { namespaces: [], removed: 'qaenv' }]);
    assert.deepEqual(settingsOf(t.srv).knownNamespaces, []);
    assert.deepEqual((await t.call('/api/namespaces')).body.namespaces, []);
    assert.equal((await t.call('/api/namespaces/known/Not_A_Name', { method: 'DELETE' })).status, 400);
  });
});

describe('a Role in two namespaces', () => {
  test('each is added by name (one request a name); both are listed, and each has its own lists', async () => {
    const t = await setup({ cluster: { namespace: ['qaenv', 'default'] } });
    try {
      for (const name of ['qaenv', 'default']) {
        const r = await t.call('/api/namespaces/known', { method: 'POST', body: { name } });
        assert.deepEqual([r.status, r.body.added, r.body.verified], [200, name, true]);
      }
      assert.deepEqual((await t.call('/api/namespaces')).body.namespaces, ['default', 'qaenv']);
      assert.deepEqual(settingsOf(t.srv).knownNamespaces, [{ context: 'qa-eks', namespaces: ['default', 'qaenv'] }]);
      assert.equal((await t.call('/api/resources/qaenv')).body.pods.length, 3);
      assert.equal((await t.call('/api/resources/default')).status, 200);
      // A third one they have nothing in is still refused, and changes nothing.
      assert.equal((await t.call('/api/namespaces/known', { method: 'POST', body: { name: 'prodenv' } })).status, 403);
      assert.deepEqual((await t.call('/api/namespaces')).body.namespaces, ['default', 'qaenv']);
      // Taking one off leaves the other.
      await t.call('/api/namespaces/known/default', { method: 'DELETE' });
      assert.deepEqual(settingsOf(t.srv).knownNamespaces, [{ context: 'qa-eks', namespaces: ['qaenv'] }]);
    } finally { await t.stop(); }
  });
});

describe('other ways a user knows their namespaces', () => {
  test('the namespace their kubeconfig context names is there without adding anything', async () => {
    const t = await setup({ kubeconfig: { namespace: 'qaenv' } });
    try {
      assert.deepEqual((await t.call('/api/namespaces')).body.namespaces, ['qaenv']);
      assert.equal((await t.call('/api/resources/qaenv')).body.pods.length, 3);
    } finally { await t.stop(); }
  });

  test('a cluster that cannot say what a user may do (webhook authoriser): the name is taken on trust', async () => {
    const t = await setup({ cluster: { rules: [], incompleteRules: true } });
    try {
      const r = await t.call('/api/namespaces/known', { method: 'POST', body: { name: 'team-a' } });
      assert.deepEqual([r.status, r.body.namespaces, r.body.verified], [200, ['team-a'], false]);
    } finally { await t.stop(); }
  });

  test('may list namespaces (a ClusterRole for that) but work in one: the full list, and still no summary', async () => {
    const t = await setup({ cluster: { clusterRules: [{ apiGroups: [''], resources: ['namespaces'], verbs: ['get', 'list', 'watch'] }] } });
    try {
      const ns = await t.call('/api/namespaces');
      assert.deepEqual(ns.body.namespaces.sort(), ['default', 'kube-system', 'prodenv', 'qaenv']);
      assert.equal(ns.body.restricted, undefined);
      assert.equal((await t.call('/api/config/auth')).body.limited, undefined);
      assert.equal((await t.call('/api/cluster/summary')).body.limited, true);
      assert.equal((await t.call('/api/resources/qaenv')).body.pods.length, 3);
      assert.equal((await t.call('/api/resources/prodenv')).status, 403);
    } finally { await t.stop(); }
  });
});
