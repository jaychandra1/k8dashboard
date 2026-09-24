// kubectl-free operation: unit tests for the REST-mapping / patch helpers in
// lib/k8s-ops.mjs, the kubectl availability probe, the friendly
// `kubectl_required` error mapping, and HTTP checks that the capabilities
// endpoint has the documented shape and that port-forward / the pod terminal
// answer `kubectl_required` when the binary is missing
// (KUBEPILOT_KUBECTL_BIN=/nonexistent).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {
  restMappingFor, normalizeKind, restartPatch, restartTarget, scaleTarget, scalePatch, parseApplyDocuments,
  validateApplyDocument, argoSyncPatch, argoRefreshPatch, dropFinalizersPatch, resourcePath, resourceLabel,
  requestOptions, patchOptions, PatchStrategy, RESTARTED_AT_ANNOTATION,
} from '../lib/k8s-ops.mjs';
import { mapUpstreamError, KUBECTL_REQUIRED_MESSAGE } from '../lib/http-errors.mjs';
import { hasKubectl, kubectlMissingError, isSpawnMissing } from '../lib/kubectl.mjs';
import { startServer, TOKEN } from './helpers/server.mjs';

const CRDS = [
  { name: 'applications.argoproj.io', group: 'argoproj.io', kind: 'Application', plural: 'applications', singular: 'application', scope: 'Namespaced', version: 'v1alpha1' },
  { name: 'clusterissuers.cert-manager.io', group: 'cert-manager.io', kind: 'ClusterIssuer', plural: 'clusterissuers', singular: 'clusterissuer', scope: 'Cluster', version: 'v1' },
];

describe('restMappingFor', () => {
  test('maps camelCase route kinds, plurals and short names to built-ins', () => {
    assert.equal(normalizeKind('statefulSet'), 'statefulset');
    assert.deepEqual(restMappingFor('statefulSet'), { apiVersion: 'apps/v1', kind: 'StatefulSet', plural: 'statefulsets', namespaced: true, group: 'apps', version: 'v1' });
    assert.equal(restMappingFor('deployments').kind, 'Deployment');
    assert.equal(restMappingFor('deploy').kind, 'Deployment');
    assert.equal(restMappingFor('svc').apiVersion, 'v1');
    assert.equal(restMappingFor('deployments.apps').kind, 'Deployment');
  });

  test('cluster-scoped built-ins are flagged as such', () => {
    assert.equal(restMappingFor('node').namespaced, false);
    assert.equal(restMappingFor('clusterRoleBinding').namespaced, false);
    assert.equal(restMappingFor('customresourcedefinition').apiVersion, 'apiextensions.k8s.io/v1');
  });

  test('resolves CRDs by kind, plural or plural.group with the storage version', () => {
    assert.equal(restMappingFor('application'), null);
    const m = restMappingFor('applications.argoproj.io', CRDS);
    assert.deepEqual(m, { apiVersion: 'argoproj.io/v1alpha1', kind: 'Application', plural: 'applications', namespaced: true, group: 'argoproj.io', version: 'v1alpha1' });
    assert.equal(restMappingFor('application', CRDS).plural, 'applications');
    assert.equal(restMappingFor('clusterissuer', CRDS).namespaced, false);
    assert.equal(restMappingFor('applications.other.io', CRDS), null);
    assert.equal(restMappingFor('nosuchkind', CRDS), null);
    assert.equal(restMappingFor(''), null);
  });

  test('resourcePath / resourceLabel follow the API and kubectl conventions', () => {
    const dep = restMappingFor('deployment');
    assert.equal(resourcePath(dep, { namespace: 'shop', name: 'web' }), '/apis/apps/v1/namespaces/shop/deployments/web');
    assert.equal(resourcePath(dep, { namespace: 'shop', name: 'web', subresource: 'scale' }), '/apis/apps/v1/namespaces/shop/deployments/web/scale');
    assert.equal(resourcePath(restMappingFor('node'), { namespace: 'ignored', name: 'n1' }), '/api/v1/nodes/n1');
    assert.equal(resourcePath(restMappingFor('pod'), { namespace: 'a b', name: 'p' }), '/api/v1/namespaces/a%20b/pods/p');
    assert.equal(resourceLabel(dep, 'web'), 'deployment.apps/web');
    assert.equal(resourceLabel(restMappingFor('pod'), 'p'), 'pod/p');
  });
});

describe('patch bodies and targets', () => {
  test('restartPatch sets the kubectl restartedAt annotation on the pod template', () => {
    const at = new Date('2026-01-02T03:04:05.000Z');
    assert.deepEqual(restartPatch(at), { spec: { template: { metadata: { annotations: { [RESTARTED_AT_ANNOTATION]: '2026-01-02T03:04:05.000Z' } } } } });
    assert.equal(RESTARTED_AT_ANNOTATION, 'kubectl.kubernetes.io/restartedAt');
    assert.ok(Date.parse(restartPatch().spec.template.metadata.annotations[RESTARTED_AT_ANNOTATION]) > 0);
  });

  test('restartTarget covers Deployment/StatefulSet/DaemonSet and rejects the rest with 400', () => {
    assert.deepEqual(restartTarget('deployment'), { api: 'AppsV1Api', method: 'patchNamespacedDeployment' });
    assert.deepEqual(restartTarget('statefulSet'), { api: 'AppsV1Api', method: 'patchNamespacedStatefulSet' });
    assert.deepEqual(restartTarget('ds'), { api: 'AppsV1Api', method: 'patchNamespacedDaemonSet' });
    assert.throws(() => restartTarget('pod'), (e) => e.status === 400 && e.code === 'not_restartable');
  });

  test('scaleTarget maps to the /scale patch methods; DaemonSets are a 400', () => {
    assert.deepEqual(scaleTarget('deployment'), { api: 'AppsV1Api', method: 'patchNamespacedDeploymentScale' });
    assert.deepEqual(scaleTarget('statefulset'), { api: 'AppsV1Api', method: 'patchNamespacedStatefulSetScale' });
    assert.deepEqual(scaleTarget('replicaSet'), { api: 'AppsV1Api', method: 'patchNamespacedReplicaSetScale' });
    assert.throws(() => scaleTarget('daemonSet'), (e) => e.status === 400 && e.code === 'not_scalable' && /DaemonSets cannot be scaled/.test(e.message));
    assert.throws(() => scaleTarget('configMap'), (e) => e.status === 400 && e.code === 'not_scalable');
    assert.deepEqual(scalePatch('3'), { spec: { replicas: 3 } });
  });

  test('Argo CD sync / refresh / orphan patches match the kubectl equivalents', () => {
    assert.deepEqual(argoSyncPatch({}), { operation: { initiatedBy: { username: 'kubepilot' }, sync: {} } });
    assert.deepEqual(
      argoSyncPatch({ prune: true, dryRun: true, revision: 'main', applyOnly: true, replace: true, force: true }),
      { operation: { initiatedBy: { username: 'kubepilot' }, sync: { prune: true, dryRun: true, revision: 'main', syncOptions: ['ApplyOutOfSyncOnly=true', 'Replace=true', 'Force=true'] } } },
    );
    assert.deepEqual(argoRefreshPatch(true), { metadata: { annotations: { 'argocd.argoproj.io/refresh': 'hard' } } });
    assert.deepEqual(argoRefreshPatch(false), { metadata: { annotations: { 'argocd.argoproj.io/refresh': 'normal' } } });
    assert.deepEqual(dropFinalizersPatch(), { metadata: { finalizers: null } });
  });

  test('requestOptions / patchOptions produce appendable client middleware', () => {
    const o = requestOptions(1000);
    assert.equal(o.middlewareMergeStrategy, 'append');
    assert.equal(o.middleware.length, 1);
    const p = patchOptions(PatchStrategy.MergePatch, 1000);
    assert.equal(p.middlewareMergeStrategy, 'append');
    assert.equal(p.middleware.length, 2);
    assert.equal(PatchStrategy.ServerSideApply, 'application/apply-patch+yaml');
  });
});

describe('applyDocuments splitting (parseApplyDocuments)', () => {
  test('splits multi-document YAML, ignoring empty documents', () => {
    const docs = parseApplyDocuments('apiVersion: v1\nkind: ConfigMap\nmetadata: {name: a}\n---\n---\napiVersion: v1\nkind: Secret\nmetadata: {name: b}\n---\n');
    assert.equal(docs.length, 2);
    assert.deepEqual(docs.map((d) => d.kind), ['ConfigMap', 'Secret']);
  });

  test('rejects empty, oversized, malformed and non-object documents with 400 invalid_yaml', () => {
    for (const bad of ['', '   ', '- just\n- a list\n', 'key: [unclosed', 'x'.repeat(3 * 1024 * 1024 + 1)]) {
      assert.throws(() => parseApplyDocuments(bad), (e) => e.status === 400 && e.code === 'invalid_yaml');
    }
    assert.throws(() => parseApplyDocuments(42), (e) => e.status === 400);
  });

  test('validateApplyDocument requires apiVersion, kind and metadata.name', () => {
    assert.ok(validateApplyDocument({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'a' } }));
    assert.throws(() => validateApplyDocument({ kind: 'ConfigMap', metadata: { name: 'a' } }), /apiVersion/);
    assert.throws(() => validateApplyDocument({ apiVersion: 'v1', metadata: { name: 'a' } }), /kind/);
    assert.throws(() => validateApplyDocument({ apiVersion: 'v1', kind: 'ConfigMap', metadata: {} }), /metadata\.name/);
  });
});

describe('kubectl absence', () => {
  test('hasKubectl honours KUBEPILOT_KUBECTL_BIN and reports { available, path }', async () => {
    const prev = process.env.KUBEPILOT_KUBECTL_BIN;
    process.env.KUBEPILOT_KUBECTL_BIN = '/nonexistent/kubectl';
    try {
      const r = await hasKubectl({ refresh: true });
      assert.deepEqual(r, { available: false, path: null });
      process.env.KUBEPILOT_KUBECTL_BIN = process.execPath; // any executable file
      const r2 = await hasKubectl({ refresh: true });
      assert.equal(r2.available, true);
      assert.equal(r2.path, process.execPath);
    } finally {
      if (prev === undefined) delete process.env.KUBEPILOT_KUBECTL_BIN; else process.env.KUBEPILOT_KUBECTL_BIN = prev;
      await hasKubectl({ refresh: true });
    }
  });

  test('kubectlMissingError and stray spawn ENOENT errors map to 501 kubectl_required', () => {
    const e = kubectlMissingError();
    assert.equal(e.status, 501);
    assert.equal(e.code, 'kubectl_required');
    assert.equal(e.message, KUBECTL_REQUIRED_MESSAGE);
    assert.deepEqual(mapUpstreamError(e), { status: 501, error: KUBECTL_REQUIRED_MESSAGE, code: 'kubectl_required' });

    const enoent = Object.assign(new Error('spawn kubectl ENOENT'), { code: 'ENOENT', syscall: 'spawn kubectl', path: 'kubectl' });
    assert.equal(isSpawnMissing(enoent), true);
    assert.equal(isSpawnMissing(Object.assign(new Error('x'), { code: 'ENOENT', syscall: 'open' })), false);
    const mapped = mapUpstreamError(enoent);
    assert.equal(mapped.status, 501);
    assert.equal(mapped.code, 'kubectl_required');
    assert.ok(!/ENOENT/.test(mapped.error), 'the raw spawn error must not leak');
    assert.match(mapped.error, /kubernetes\.io\/docs\/tasks\/tools/);
  });
});

// HTTP: a real server with a (dead) kubeconfig, demo mode off and kubectl
// pointed at a path that does not exist.
describe('HTTP without kubectl', () => {
  let srv, dir;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubepilot-nokubectl-'));
    const kubeconfig = path.join(dir, 'config');
    fs.writeFileSync(kubeconfig, [
      'apiVersion: v1', 'kind: Config',
      'clusters:', '- name: c', '  cluster:', '    server: https://127.0.0.1:1',
      'users:', '- name: u', '  user:', '    token: not-a-real-token',
      'contexts:', '- name: ctx', '  context:', '    cluster: c', '    user: u',
      'current-context: ctx', '',
    ].join('\n'));
    srv = await startServer({ env: { KUBECONFIG: kubeconfig, KUBEPILOT_DEMO: '', KUBEPILOT_KUBECTL_BIN: '/nonexistent/kubectl' } });
  });
  after(async () => {
    if (srv) await srv.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('GET /api/config/capabilities → { kubectl: { available, path }, terminal, portForward }', async () => {
    const res = await srv.authed('/api/config/capabilities');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['kubectl', 'portForward', 'terminal']);
    assert.deepEqual(body.kubectl, { available: false, path: null });
    assert.equal(body.terminal, false);
    assert.equal(body.portForward, false);
    const again = await (await srv.authed('/api/config/capabilities?refresh=1')).json();
    assert.equal(again.kubectl.available, false);
  });

  test('capabilities requires the bearer token', async () => {
    const res = await fetch(`${srv.base}/api/config/capabilities`);
    assert.equal(res.status, 401);
  });

  test('POST /api/portforward → 501 kubectl_required with the actionable message', async () => {
    const res = await srv.authed('/api/portforward', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace: 'default', name: 'web', remotePort: 80 }),
    });
    assert.equal(res.status, 501);
    const body = await res.json();
    assert.equal(body.code, 'kubectl_required');
    assert.equal(body.error, KUBECTL_REQUIRED_MESSAGE);
  });

  test('the pod terminal upgrade is refused with kubectl_required', async () => {
    const outcome = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws/exec?token=${TOKEN}&namespace=default&pod=web-0`, { origin: `http://127.0.0.1:${srv.port}` });
      ws.on('unexpected-response', (req, res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      ws.on('open', () => { ws.close(); resolve({ status: 101 }); });
      ws.on('error', (e) => resolve({ status: 0, error: e.message }));
    });
    assert.equal(outcome.status, 501, JSON.stringify(outcome));
    assert.equal(JSON.parse(outcome.body).code, 'kubectl_required');
  });

  test('reads no longer shell out: /api/nodes answers with an API error, never "spawn kubectl"', async () => {
    const res = await srv.authed('/api/nodes');
    assert.notEqual(res.status, 200); // the cluster at 127.0.0.1:1 is unreachable
    const body = await res.json();
    assert.ok(Array.isArray(body.nodes));
    assert.ok(!/spawn|ENOENT/i.test(body.error || ''), body.error);
  });
});
