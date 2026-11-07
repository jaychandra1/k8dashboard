// Audit SEC-02: kubeconfig exec credential plugins are started by
// @kubernetes/client-node with the server's environment. K8Board's own
// secrets (the API token under every name, the MCP token, the LLM key) must
// never reach them, whether or not the kubeconfig entry sets its own `env`.
// A stub plugin records the environment it was given.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, TOKEN } from './helpers/server.mjs';
import { holdAppSecrets, appSecretEnv, isAppSecretEnv } from '../lib/child-env.mjs';

const PLUGIN = `import fs from 'node:fs';
const out = process.argv[2];
fs.writeFileSync(out, JSON.stringify(process.env));
process.stdout.write(JSON.stringify({
  apiVersion: 'client.authentication.k8s.io/v1beta1', kind: 'ExecCredential',
  status: { token: 'stub-plugin-token' },
}));
`;

const SECRETS = {
  K8BOARD_MCP_TOKEN: 'mcp-secret-0123456789abcdef',
  K8SIGHT_TOKEN: 'legacy-api-token-0123456789',
  LLM_API_KEY: 'sk-llm-secret-0123456789',
  MCP_API_TOKEN: 'mcp-bridge-secret-0123456789',
};

describe('exec credential plugins never inherit K8Board secrets (SEC-02)', () => {
  let srv, dir;
  const dump = (name) => path.join(dir, `${name}.json`);
  const call = async (p, body) => {
    const init = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
    const r = await srv.authed(p, init);
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-plugin-env-'));
    const plugin = path.join(dir, 'stub-plugin.mjs');
    fs.writeFileSync(plugin, PLUGIN);
    const user = (name, withEnv) => [
      `- name: ${name}`, '  user:', '    exec:', '      apiVersion: client.authentication.k8s.io/v1beta1',
      `      command: ${JSON.stringify(process.execPath)}`, `      args: [${JSON.stringify(plugin)}, ${JSON.stringify(dump(name))}]`,
      ...(withEnv ? ['      env: [{ name: PLUGIN_EXTRA, value: "from-kubeconfig" }]'] : []),
    ];
    fs.writeFileSync(path.join(dir, 'config'), [
      'apiVersion: v1', 'kind: Config', 'current-context: plain',
      'clusters:', '- name: c', "  cluster: { server: 'https://127.0.0.1:9', insecure-skip-tls-verify: true }",
      'users:', ...user('plain', false), ...user('with-env', true),
      'contexts:',
      '- name: plain', '  context: { cluster: c, user: plain }',
      '- name: with-env', '  context: { cluster: c, user: with-env }', '',
    ].join('\n'));
    srv = await startServer({
      env: { KUBEPILOT_DEMO: '', KUBECONFIG: path.join(dir, 'config'), K8BOARD_PLUGIN_CANARY: 'visible', ...SECRETS },
    });
  });
  after(async () => {
    await srv?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const assertClean = (name) => {
    const env = JSON.parse(fs.readFileSync(dump(name), 'utf8'));
    const leaked = Object.keys(env).filter(isAppSecretEnv);
    assert.deepEqual(leaked, [], `secret variables reached the plugin: ${leaked.join(', ')}`);
    const values = Object.values(env).join('\n');
    for (const secret of [...Object.values(SECRETS), TOKEN]) assert.ok(!values.includes(secret), 'no secret value under any name');
    assert.equal(env.K8BOARD_PLUGIN_CANARY, 'visible', 'the rest of the environment is passed through');
    return env;
  };

  test('a plugin entry without its own env', async () => {
    await call('/api/config/auth');
    assertClean('plain');
  });

  test('a plugin entry with its own env', async () => {
    assert.equal((await call('/api/config/context', { contextName: 'with-env' })).status, 200);
    await call('/api/config/auth');
    assert.equal(assertClean('with-env').PLUGIN_EXTRA, 'from-kubeconfig');
  });

  test('the server still accepts its API token and reports the MCP token it was given', async () => {
    assert.equal((await call('/api/config/status')).status, 200);
    const mcp = await call('/api/mcp/info');
    assert.equal(mcp.status, 200);
    assert.equal(mcp.body.token, SECRETS.K8BOARD_MCP_TOKEN);
  });
});

describe('holdAppSecrets', () => {
  test('moves the secrets out of the environment and keeps them readable', () => {
    const env = { K8BOARD_TOKEN: 'a', KUBEPILOT_MCP_TOKEN: 'b', LLM_API_KEY: 'c', PATH: '/bin', LLM_MODEL: 'm' };
    const removed = holdAppSecrets(env);
    assert.deepEqual(removed.sort(), ['K8BOARD_TOKEN', 'KUBEPILOT_MCP_TOKEN', 'LLM_API_KEY']);
    assert.deepEqual(env, { PATH: '/bin', LLM_MODEL: 'm' });
    assert.equal(appSecretEnv('K8BOARD_TOKEN'), 'a');
    assert.equal(appSecretEnv('KUBEPILOT_MCP_TOKEN'), 'b');
    assert.equal(appSecretEnv('LLM_API_KEY'), 'c');
  });
});
