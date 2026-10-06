// POST /api/apply — the "Apply manifests" dialog (and the MCP apply tool):
// multi-document server-side apply with an optional dry run and a target
// namespace, all documents validated first, per-document results. Runs the
// real server against an in-process fake Kubernetes API.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer, freePort } from './helpers/server.mjs';

describe('POST /api/apply', () => {
  let srv, fake, dir;
  let patches = [];

  before(async () => {
    const fakePort = await freePort();
    fake = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://fake');
      const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'GET' && url.pathname === '/api/v1') {
        return send(200, { kind: 'APIResourceList', groupVersion: 'v1', resources: [
          { name: 'configmaps', namespaced: true, kind: 'ConfigMap', verbs: ['get', 'patch'] },
          { name: 'namespaces', namespaced: false, kind: 'Namespace', verbs: ['get', 'patch'] },
        ] });
      }
      if (req.method === 'GET' && url.pathname === '/apis/apps/v1') {
        return send(200, { kind: 'APIResourceList', groupVersion: 'apps/v1', resources: [{ name: 'deployments', namespaced: true, kind: 'Deployment', verbs: ['get', 'patch'] }] });
      }
      if (req.method === 'PATCH') {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
          patches.push({ path: url.pathname, dryRun: url.searchParams.get('dryRun'), fieldManager: url.searchParams.get('fieldManager'), contentType: req.headers['content-type'], body });
          if (url.pathname.endsWith('/rejected')) {
            return send(422, { kind: 'Status', status: 'Failure', code: 422, reason: 'Invalid', message: 'admission webhook "policy.example.com" denied the request: nope' });
          }
          return send(200, { kind: 'Object', metadata: { name: url.pathname.split('/').pop() } });
        });
        return undefined;
      }
      return send(404, { kind: 'Status', status: 'Failure', code: 404, reason: 'NotFound', message: 'not found' });
    });
    await new Promise((r) => fake.listen(fakePort, '127.0.0.1', r));

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubepilot-apply-'));
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

  beforeEach(() => { patches = []; });

  const post = (body) => srv.authed('/api/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const MANIFESTS = [
    'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app-config\ndata:\n  k: v',
    'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n  namespace: shop\nspec: {}',
    'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: team',
  ].join('\n---\n');

  test('applies every document; the chosen namespace fills in for documents without one', async () => {
    const res = await post({ yaml: MANIFESTS, namespace: 'team' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.dryRun, false);
    assert.deepEqual(body.results.map((r) => [r.ok, r.label, r.namespace ?? null]), [
      [true, 'configmap/app-config', 'team'],
      [true, 'deployment.apps/web', 'shop'],
      [true, 'namespace/team', null],
    ]);
    assert.deepEqual(patches.map((p) => p.path), [
      '/api/v1/namespaces/team/configmaps/app-config',
      '/apis/apps/v1/namespaces/shop/deployments/web',
      '/api/v1/namespaces/team',
    ]);
    assert.ok(patches.every((p) => p.dryRun === null && p.fieldManager === 'kubepilot' && /apply-patch\+yaml/.test(p.contentType)));
    assert.match(body.message, /configmap\/app-config serverside-applied/);
  });

  test('without a namespace, documents without one go to the context namespace (default)', async () => {
    await post({ yaml: MANIFESTS.split('\n---\n')[0] });
    assert.equal(patches[0].path, '/api/v1/namespaces/default/configmaps/app-config');
  });

  test('dry run sends dryRun=All and says so', async () => {
    const res = await post({ yaml: MANIFESTS, dryRun: true });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.dryRun, true);
    assert.ok(patches.length === 3 && patches.every((p) => p.dryRun === 'All'));
    assert.ok(body.results.every((r) => /\(server dry run\)$/.test(r.message)));
  });

  test('a malformed document stops everything before anything is sent', async () => {
    const res = await post({ yaml: `${MANIFESTS.split('\n---\n')[0]}\n---\napiVersion: v1\nkind: ConfigMap\nmetadata: {}\n` });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'invalid_yaml');
    assert.equal(body.error, 'Document 2: Manifest is missing metadata.name');
    assert.equal(patches.length, 0);
  });

  test('a rejected document is reported with the API server\'s reason; the others still apply (like kubectl)', async () => {
    const yaml = [
      'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: first',
      'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: rejected',
      'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: third',
    ].join('\n---\n');
    const res = await post({ yaml });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.code, 'apply_failed');
    assert.deepEqual(body.results.map((r) => r.ok), [true, false, true]);
    assert.equal(body.results[1].error, 'admission webhook "policy.example.com" denied the request: nope');
    assert.match(body.error, /^1 of 3 manifests failed — configmap\/rejected: admission webhook/);
    assert.equal(patches.length, 3);
  });

  test('an unknown kind is a per-document error', async () => {
    const res = await post({ yaml: 'apiVersion: v1\nkind: Gizmo\nmetadata:\n  name: g' });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.match(body.results[0].error, /Unknown kind "Gizmo"/);
    assert.equal(patches.length, 0);
  });

  test('an invalid target namespace is rejected', async () => {
    const res = await post({ yaml: MANIFESTS, namespace: 'Not_A_Namespace' });
    assert.equal(res.status, 400);
    assert.equal(patches.length, 0);
  });
});
