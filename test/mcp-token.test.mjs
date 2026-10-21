// AI agents get their own MCP token: requests made with it are MCP requests
// whatever headers they send (write gate, UI-only routes, no terminals), it
// persists and can be regenerated, and Secret values are masked for agents
// unless the user opts in. Also: credential scrubbing for the assistant's LLM
// and its http:// policy.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { redactSecretsInText } from '../lib/redact-secrets.mjs';
import { startServer, TOKEN } from './helpers/server.mjs';

// A minimal Kubernetes API: one Secret and one Pod in namespace "apps".
const SECRET = {
  apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
  metadata: {
    name: 'db', namespace: 'apps',
    annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"data":{"password":"aHVudGVyMg=="}}', team: 'core' },
  },
  data: { password: 'aHVudGVyMg==', user: 'YWRtaW4=' },
};
const POD = {
  apiVersion: 'v1', kind: 'Pod',
  metadata: { name: 'web', namespace: 'apps' },
  spec: { containers: [{ name: 'web', image: 'nginx', env: [{ name: 'DB_PASSWORD', value: 'hunter2' }, { name: 'MODE', value: 'prod' }] }] },
};
function fakeKubeApi() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const body = req.url.startsWith('/api/v1/namespaces/apps/secrets/db') ? SECRET
        : req.url.startsWith('/api/v1/namespaces/apps/pods/web') ? POD : null;
      res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body || { kind: 'Status', code: 404, message: 'not found' }));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

describe('MCP token', () => {
  let srv, kube, dir, mcpToken;
  const as = (token, p, init = {}) =>
    fetch(srv.base + p, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  const post = (token, p, body) =>
    as(token, p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

  before(async () => {
    kube = await fakeKubeApi();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-mcp-token-'));
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
    const info = await (await as(TOKEN, '/api/mcp/info')).json();
    mcpToken = info.token;
  });
  after(async () => {
    await srv?.stop();
    kube?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('Preferences gets the MCP token — never the UI token — and it is persisted (0600)', async () => {
    const info = await (await as(TOKEN, '/api/mcp/info')).json();
    assert.ok(mcpToken && mcpToken !== TOKEN);
    assert.equal(info.stdioEnv.MCP_API_TOKEN, mcpToken);
    assert.equal(info.allowWrite, false);
    assert.equal(info.allowSecrets, false);
    assert.ok(info.writeTools.includes('switch_context') && !info.readTools.includes('switch_context'));
    const file = path.join(srv.home, '.config', 'kubepilot', 'mcp-token');
    assert.equal(fs.readFileSync(file, 'utf8').trim(), mcpToken);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  test('reads work with the MCP token; writes are gated even without the MCP header', async () => {
    assert.equal((await as(mcpToken, '/api/config/status')).status, 200);
    const scale = await post(mcpToken, '/api/scale/apps/deployment/web', { replicas: 2 });
    assert.equal(scale.status, 403);
    assert.equal((await scale.json()).code, 'mcp_write_disabled');
    const ctx = await post(mcpToken, '/api/config/context', { contextName: 'dev' });
    assert.equal(ctx.status, 403, 'switching context is a write');
    const del = await as(mcpToken, '/api/portforward/pf-1', { method: 'DELETE' });
    assert.equal(del.status, 403);
  });

  test('UI-only routes refuse the MCP token: MCP settings, kubeconfig, cloud, assistant, updates, settings', async () => {
    const checks = [
      ['GET', '/api/mcp/info'], ['POST', '/api/mcp/config', { allowWrite: true }], ['POST', '/api/mcp/token'],
      ['POST', '/api/config/load', { path: '/etc/passwd' }], ['POST', '/api/config/reload'],
      ['GET', '/api/aws/profiles'], ['POST', '/api/azure/login'], ['GET', '/api/assistant/status'],
      ['POST', '/api/security/scan'], ['POST', '/api/ai-agents/launch-external', { agentId: 'claude' }],
      ['GET', '/api/app/update'], ['GET', '/api/settings/pins'],
    ];
    for (const [method, p, body] of checks) {
      const r = method === 'GET' ? await as(mcpToken, p) : await post(mcpToken, p, body);
      assert.equal(r.status, 403, `${method} ${p}`);
      assert.equal((await r.json()).code, 'mcp_forbidden', `${method} ${p}`);
    }
    // …while the UI token still reaches them.
    assert.equal((await as(TOKEN, '/api/settings/pins')).status, 200);
  });

  test('the MCP token never opens a terminal', async () => {
    const status = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws/exec?token=${mcpToken}&namespace=apps&pod=web`, { origin: srv.base });
      ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
      ws.on('open', () => { ws.close(); resolve(101); });
      ws.on('error', () => resolve(0));
    });
    assert.equal(status, 401);
  });

  test('Secret values and secret-looking env values are masked for agents; the UI sees everything', async () => {
    const ui = await (await as(TOKEN, '/api/resource/apps/Secret/db')).json();
    assert.equal(ui.data.password, 'aHVudGVyMg==');

    const agent = await (await as(mcpToken, '/api/resource/apps/Secret/db')).json();
    assert.deepEqual(agent.data, { password: '<redacted>', user: '<redacted>' });
    assert.equal(agent.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'], undefined);
    assert.equal(agent.metadata.annotations.team, 'core');

    // Older bridges: the UI token + the MCP header is an MCP request too.
    const legacy = await (await as(TOKEN, '/api/resource/apps/Secret/db', { headers: { 'X-KubePilot-Source': 'mcp' } })).json();
    assert.equal(legacy.data.password, '<redacted>');

    const yamlText = (await (await as(mcpToken, '/api/yaml/apps/secret/db')).json()).yaml;
    assert.doesNotMatch(yamlText, /aHVudGVyMg==|YWRtaW4=/);
    assert.match(yamlText, /password: <redacted>/);

    const pod = await (await as(mcpToken, '/api/resource/apps/Pod/web')).json();
    assert.deepEqual(pod.spec.containers[0].env, [{ name: 'DB_PASSWORD', value: '<redacted>' }, { name: 'MODE', value: 'prod' }]);
  });

  test('opting in shows agents Secret values', async () => {
    const r = await post(TOKEN, '/api/mcp/config', { allowSecrets: true });
    assert.deepEqual(await r.json(), { allowWrite: false, allowSecrets: true });
    try {
      const agent = await (await as(mcpToken, '/api/resource/apps/Secret/db')).json();
      assert.equal(agent.data.password, 'aHVudGVyMg==');
    } finally {
      await post(TOKEN, '/api/mcp/config', { allowSecrets: false });
    }
    assert.equal((await post(TOKEN, '/api/mcp/config', { allowSecrets: 'yes' })).status, 400);
    assert.equal((await post(TOKEN, '/api/mcp/config', {})).status, 400);
  });

  test('regenerating replaces the token: the old one stops working at once', async () => {
    const r = await post(TOKEN, '/api/mcp/token');
    assert.equal(r.status, 200);
    const fresh = (await r.json()).token;
    assert.ok(fresh && fresh !== mcpToken && fresh !== TOKEN);
    assert.equal((await as(mcpToken, '/api/config/status')).status, 401);
    assert.equal((await as(fresh, '/api/config/status')).status, 200);
    assert.equal(fs.readFileSync(path.join(srv.home, '.config', 'kubepilot', 'mcp-token'), 'utf8').trim(), fresh);
    mcpToken = fresh;
  });

  test('the assistant refuses plain http:// to an internet LLM provider (local / private is fine)', async () => {
    const pub = await post(TOKEN, '/api/assistant/config', { baseUrl: 'http://8.8.8.8/v1', apiKey: 'k', model: 'm' });
    assert.equal(pub.status, 400);
    assert.match((await pub.json()).error, /Use https:\/\//);
    const local = await post(TOKEN, '/api/assistant/config', { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm' });
    assert.doesNotMatch((await local.json()).error || '', /Use https:\/\//);
  });
});

describe('credential scrubbing for the assistant', () => {
  test('private keys, JWTs, auth headers, cloud keys, URL passwords and key=value secrets', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeXN0ZW06c2EifQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ';
    const input = [
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
      `token: ${jwt}`,
      'Authorization: Bearer abcdefgh12345678',
      'aws key AKIAABCDEFGHIJKLMNOP used',
      'connect postgres://app:s3cr3tpw@db:5432/app',
      'DB_PASSWORD=hunter2 MODE=prod',
      '{"apiKey": "sk-live-value-123", "region": "eu-west-1"}',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    ].join('\n');
    const out = redactSecretsInText(input);
    for (const leak of ['MIIEow', jwt, 'abcdefgh12345678', 'AKIAABCDEFGHIJKLMNOP', 's3cr3tpw', 'hunter2', 'sk-live-value-123', 'ghp_abcdef']) {
      assert.ok(!out.includes(leak), `leaked ${leak}:\n${out}`);
    }
    for (const kept of ['MODE=prod', 'eu-west-1', 'postgres://app:', '@db:5432/app', 'aws key', 'used']) {
      assert.ok(out.includes(kept), `lost ${kept}:\n${out}`);
    }
    assert.equal(redactSecretsInText('Readiness probe failed: HTTP 503'), 'Readiness probe failed: HTTP 503');
    assert.equal(redactSecretsInText(42), 42);
  });
});
