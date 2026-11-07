// Audit SEC-03: what AI agents read over MCP — pod logs, events, custom
// resources, Helm values and manifests, object YAML — has credentials masked
// unless the user lets agents read secret values (Preferences → MCP). The UI
// sees everything. Unit tests for lib/agent-scrub.mjs, then the real server
// against a fake Kubernetes API.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer, TOKEN } from './helpers/server.mjs';
import { scrubForAgent, scrubYamlForAgent, scrubResponseForAgent, isCredentialKey } from '../lib/agent-scrub.mjs';

const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeXN0ZW06c2EifQ.c2lnbmF0dXJlLXZhbHVl';

describe('agent-scrub', () => {
  test('credential fields lose their value; fields that point at one keep it', () => {
    const input = {
      auth: { password: 'hunter2', existingSecret: 'db-creds', passwordFile: '/run/pw', secretName: 'tls', tokenTTL: '1h' },
      apiKey: 'k-123', clientSecret: 'cs', replicas: 3, enabled: true,
      env: [{ name: 'DB_PASSWORD', value: 'hunter2' }, { name: 'MODE', value: 'prod' }],
      url: 'postgres://app:hunter2@db:5432/x',
      note: `Authorization: Bearer ${JWT}`,
    };
    const out = scrubForAgent(input);
    assert.deepEqual(out.auth, { password: '<redacted>', existingSecret: 'db-creds', passwordFile: '/run/pw', secretName: 'tls', tokenTTL: '1h' });
    assert.deepEqual([out.apiKey, out.clientSecret, out.replicas, out.enabled], ['<redacted>', '<redacted>', 3, true]);
    assert.deepEqual(out.env, [{ name: 'DB_PASSWORD', value: '<redacted>' }, { name: 'MODE', value: 'prod' }]);
    assert.equal(out.url, 'postgres://app:[redacted]@db:5432/x');
    assert.doesNotMatch(out.note, /eyJ/);
    assert.equal(input.auth.password, 'hunter2', 'the input is not changed (it may be cached)');
    assert.equal(isCredentialKey('secretKeyRef'), false);
    assert.equal(isCredentialKey('accessKey'), true);
  });

  test('Secret objects anywhere keep their keys, not their values; JSON in strings is scrubbed too', () => {
    const out = scrubForAgent({
      items: [{ kind: 'Secret', metadata: { name: 's' }, data: { 'tls.key': 'LS0t', user: 'YWRtaW4=' } }],
      metadata: { annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"spec":{"password":"hunter2","size":2}}' } },
    });
    assert.deepEqual(out.items[0].data, { 'tls.key': '<redacted>', user: '<redacted>' });
    assert.deepEqual(JSON.parse(out.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration']), { spec: { password: '<redacted>', size: 2 } });
  });

  test('YAML: Helm values and multi-document manifests, Helm source comments kept', () => {
    const values = scrubYamlForAgent('postgresql:\n  auth:\n    password: hunter2\n    username: app\nreplicas: 2\n');
    assert.match(values, /password: <redacted>/);
    assert.match(values, /username: app/);
    const manifest = scrubYamlForAgent([
      '---', '# Source: app/templates/secret.yaml', 'apiVersion: v1', 'kind: Secret', 'metadata:', '  name: db',
      'data:', '  DB_PASS: aHVudGVyMg==', '---', '# Source: app/templates/cm.yaml', 'apiVersion: v1', 'kind: ConfigMap',
      'metadata:', '  name: cfg', 'data:', '  app.properties: |', '    db.password=hunter2', '    db.pool=5', '',
    ].join('\n'));
    assert.doesNotMatch(manifest, /aHVudGVyMg==|hunter2/);
    assert.match(manifest, /# Source: app\/templates\/secret.yaml/);
    assert.match(manifest, /# Source: app\/templates\/cm.yaml/);
    assert.match(manifest, /db.pool=5/);
    assert.equal(manifest.split(/^---$/m).length, 2, 'two documents');
    // Not YAML: the text scrub still applies.
    assert.doesNotMatch(scrubYamlForAgent('a: [unclosed\npassword=hunter2'), /hunter2/);
  });

  test('response bodies: { yaml } text gets the YAML treatment, everything else the object one', () => {
    const out = scrubResponseForAgent({ yaml: 'spec:\n  token: abc\n', name: 'x', logs: `token=${JWT}` });
    assert.match(out.yaml, /token: <redacted>/);
    assert.equal(out.name, 'x');
    assert.doesNotMatch(out.logs, /eyJ/);
    assert.deepEqual(scrubResponseForAgent({ items: [] }), { items: [] });
    assert.equal(scrubResponseForAgent('text password=hunter2'), 'text password=[redacted]');
  });
});

// A minimal Kubernetes API: one pod's log, one event, one custom resource.
const LOG = `connecting to postgres://app:hunter2@db:5432/orders\nAuthorization: Bearer ${JWT}\nready\n`;
const EVENTS = {
  kind: 'EventList', apiVersion: 'v1', metadata: {},
  items: [{
    metadata: { name: 'e1', namespace: 'apps', uid: 'u1' }, involvedObject: { kind: 'Pod', name: 'web', namespace: 'apps' },
    type: 'Warning', reason: 'Failed', message: 'probe failed: api_key=sk-live-0123456789abcdef', count: 1,
    lastTimestamp: '2026-11-07T10:00:00Z', firstTimestamp: '2026-11-07T10:00:00Z',
  }],
};
const WIDGET = {
  apiVersion: 'example.com/v1', kind: 'Widget',
  metadata: { name: 'w1', namespace: 'apps', annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"spec":{"auth":{"password":"hunter2"}}}' } },
  spec: { auth: { password: 'hunter2', existingSecret: 'db-creds' }, env: [{ name: 'API_TOKEN', value: 'tok-0123456789' }], size: 2 },
};

function fakeKubeApi() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = req.url.split('?')[0];
      if (url === '/api/v1/namespaces/apps/pods/web/log') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(LOG);
      }
      const body = url === '/api/v1/namespaces/apps/events' ? EVENTS
        : url === '/apis/example.com/v1/namespaces/apps/widgets/w1' ? WIDGET : null;
      res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body || { kind: 'Status', code: 404, message: 'not found' }));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

describe('MCP responses are scrubbed (SEC-03)', () => {
  let srv, kube, dir, mcpToken;
  const as = (token, p, init = {}) => fetch(srv.base + p, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  const text = async (token, p) => {
    const r = await as(token, p);
    assert.equal(r.status, 200, `${p}: ${r.status}`);
    return r.text();
  };
  const setSecrets = (allowSecrets) => as(TOKEN, '/api/mcp/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allowSecrets }),
  });
  const ROUTES = ['/api/logs/apps/web', '/api/events/apps', '/api/customresource/example.com/v1/widgets/w1?namespace=apps'];
  const SECRETS = /hunter2|sk-live-0123456789abcdef|tok-0123456789|eyJhbGci/;

  before(async () => {
    kube = await fakeKubeApi();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-mcp-scrub-'));
    fs.writeFileSync(path.join(dir, 'config'), [
      'apiVersion: v1', 'kind: Config', 'current-context: dev',
      'clusters:', '- name: dev', `  cluster: { server: 'http://127.0.0.1:${kube.address().port}', insecure-skip-tls-verify: true }`,
      'users:', '- name: dev', '  user: { token: dev-token }',
      'contexts:', '- name: dev', '  context: { cluster: dev, user: dev }', '',
    ].join('\n'));
    srv = await startServer({ env: { KUBEPILOT_DEMO: '', KUBECONFIG: path.join(dir, 'config') } });
    mcpToken = (await (await as(TOKEN, '/api/mcp/info')).json()).token;
  });
  after(async () => {
    await srv?.stop();
    kube?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the UI sees logs, events and custom resources as they are', async () => {
    for (const p of ROUTES) assert.match(await text(TOKEN, p), SECRETS, p);
  });

  test('an agent gets them with credentials masked, the rest readable', async () => {
    const logs = await text(mcpToken, ROUTES[0]);
    assert.doesNotMatch(logs, SECRETS);
    assert.match(logs, /postgres:\/\/app:\[redacted\]@db:5432\/orders/);
    assert.match(logs, /ready/);

    const events = await text(mcpToken, ROUTES[1]);
    assert.doesNotMatch(events, SECRETS);
    assert.match(events, /probe failed/);

    const cr = JSON.parse(await text(mcpToken, ROUTES[2])).yaml;
    assert.doesNotMatch(cr, SECRETS);
    assert.match(cr, /existingSecret: db-creds/);
    assert.match(cr, /size: 2/);
  });

  test('older bridges (UI token + MCP header) are scrubbed too', async () => {
    const r = await as(TOKEN, ROUTES[0], { headers: { 'X-K8Board-Source': 'mcp' } });
    assert.doesNotMatch(await r.text(), SECRETS);
  });

  test('opting in to secret values gives agents the raw data', async () => {
    assert.equal((await setSecrets(true)).status, 200);
    try {
      for (const p of ROUTES) assert.match(await text(mcpToken, p), SECRETS, p);
    } finally {
      await setSecrets(false);
    }
    assert.doesNotMatch(await text(mcpToken, ROUTES[0]), SECRETS);
  });
});
