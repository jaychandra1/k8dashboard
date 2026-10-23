// Editing a custom resource (Custom Resources → instance → Apply):
// PUT /api/customresource/:group/:version/:plural/:name server-side applies
// the edited YAML — only when it is this very object — against a fake API
// server that serves discovery and records the apply patch.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer, TOKEN } from './helpers/server.mjs';

const DISCOVERY = {
  kind: 'APIResourceList', groupVersion: 'example.com/v1',
  resources: [
    { name: 'widgets', kind: 'Widget', namespaced: true, verbs: ['get', 'patch'] },
    { name: 'widgets/status', kind: 'Widget', namespaced: true, verbs: ['get', 'patch'] },
    { name: 'gadgets', kind: 'Gadget', namespaced: true, verbs: ['get', 'patch'] },
    { name: 'clusterwidgets', kind: 'ClusterWidget', namespaced: false, verbs: ['get', 'patch'] },
  ],
};

function fakeKubeApi() {
  const patches = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'GET' && req.url === '/apis/example.com/v1') return json(200, DISCOVERY);
      if (req.method === 'PATCH') {
        patches.push({ url: req.url, contentType: req.headers['content-type'], body });
        if (body.includes('resourceVersion: stale')) {
          return json(409, { kind: 'Status', status: 'Failure', reason: 'Conflict', code: 409, message: 'Operation cannot be fulfilled on widgets.example.com "w1": the object has been modified; please apply your changes to the latest version and try again' });
        }
        return json(200, { apiVersion: 'example.com/v1', kind: 'Widget', metadata: { name: 'w1' } });
      }
      return json(404, { kind: 'Status', code: 404 });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, patches })));
}

const widget = ({ apiVersion = 'example.com/v1', kind = 'Widget', name = 'w1', namespace = 'apps', extra = '' } = {}) => `apiVersion: ${apiVersion}
kind: ${kind}
metadata:
  name: ${name}
${namespace ? `  namespace: ${namespace}\n` : ''}${extra}spec:
  size: 3
`;

describe('PUT /api/customresource/… (edit a custom resource)', () => {
  let srv, kube, dir;
  before(async () => {
    kube = await fakeKubeApi();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-cr-edit-'));
    const kubeconfig = path.join(dir, 'config');
    fs.writeFileSync(kubeconfig, `apiVersion: v1
kind: Config
current-context: dev
clusters:
- name: dev
  cluster: { server: 'http://127.0.0.1:${kube.server.address().port}', insecure-skip-tls-verify: true }
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
    kube?.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const put = (p, yaml, headers = {}, token = TOKEN) => fetch(`${srv.base}${p}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ yaml }),
  });

  test('a namespaced instance is server-side applied like the built-in editor', async () => {
    const r = await put('/api/customresource/example.com/v1/widgets/w1?namespace=apps', widget());
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(body.message, 'widget.example.com/w1 serverside-applied');
    const sent = kube.patches.at(-1);
    assert.match(sent.url, /^\/apis\/example\.com\/v1\/namespaces\/apps\/widgets\/w1\?fieldManager=kubepilot&force=true&fieldValidation=Strict$/);
    assert.equal(sent.contentType, 'application/apply-patch+yaml');
    assert.match(sent.body, /size: 3/);
  });

  test('a cluster-scoped instance needs no namespace', async () => {
    const r = await put('/api/customresource/example.com/v1/clusterwidgets/c1', widget({ kind: 'ClusterWidget', name: 'c1', namespace: '' }));
    assert.equal(r.status, 200, JSON.stringify(await r.json()));
    assert.match(kube.patches.at(-1).url, /^\/apis\/example\.com\/v1\/clusterwidgets\/c1\?/);
  });

  test('YAML for a different object is refused before anything is sent', async () => {
    const before = kube.patches.length;
    const cases = [
      [widget({ apiVersion: 'example.com/v2' }), 'yaml_mismatch', /apiVersion "example.com\/v2"/],
      [widget({ name: 'other' }), 'yaml_mismatch', /metadata.name "other"/],
      [widget({ kind: 'Gadget' }), 'yaml_mismatch', /kind "Gadget" is not a widgets resource/],
      [widget({ namespace: 'prod' }), 'yaml_mismatch', /metadata.namespace "prod"/],
      [`${widget()}---\n${widget()}`, 'invalid_yaml', /Exactly one YAML document/],
    ];
    for (const [yaml, code, msg] of cases) {
      const r = await put('/api/customresource/example.com/v1/widgets/w1?namespace=apps', yaml);
      const body = await r.json();
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(body.code, code);
      assert.match(body.error, msg);
    }
    const noNs = await put('/api/customresource/example.com/v1/widgets/w1', widget());
    assert.equal(noNs.status, 400);
    assert.equal((await noNs.json()).code, 'invalid_param');
    assert.equal(kube.patches.length, before);
  });

  test('an edit based on a stale copy is a 409 conflict, not a generic error', async () => {
    const r = await put('/api/customresource/example.com/v1/widgets/w1?namespace=apps', widget({ extra: '  resourceVersion: stale\n' }));
    const body = await r.json();
    assert.equal(r.status, 409, JSON.stringify(body));
    assert.equal(body.code, 'conflict');
    assert.match(body.error, /has been modified/);
  });

  test('AI agents can only edit while MCP write access is on', async () => {
    const before = kube.patches.length;
    const r = await put('/api/customresource/example.com/v1/widgets/w1?namespace=apps', widget(), { 'X-KubePilot-Source': 'mcp' });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, 'mcp_write_disabled');
    assert.equal(kube.patches.length, before);
  });
});
