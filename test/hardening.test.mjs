// Host-level hardening: KubePilot's own secrets never reach the processes it
// starts, terminals that run on the KubePilot host are desktop-only, the AI
// agent terminal sees only the selected cluster, cluster-controlled prompt
// text can't run as shell code, the token stays out of production logs, and
// WebSocket frames are size-capped.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { childEnv, isAppSecretEnv } from '../lib/child-env.mjs';
import { agentPromptArg, shq } from '../lib/helm-shell.mjs';
import { spawnBin } from '../lib/kubectl.mjs';
import { startServer, TOKEN } from './helpers/server.mjs';

const KUBECONFIG_YAML = `apiVersion: v1
kind: Config
current-context: dev
clusters:
- name: dev-cluster
  cluster: { server: 'https://127.0.0.1:1', insecure-skip-tls-verify: true }
- name: prod-cluster
  cluster: { server: 'https://127.0.0.1:2', insecure-skip-tls-verify: true }
users:
- name: dev-user
  user: { token: dev-token }
- name: prod-user
  user: { token: prod-token }
contexts:
- name: dev
  context: { cluster: dev-cluster, user: dev-user }
- name: prod
  context: { cluster: prod-cluster, user: prod-user }
`;

function openWs(port, query) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/exec?token=${TOKEN}&${query}`, { origin: `http://127.0.0.1:${port}` });
    ws.on('unexpected-response', (req, res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    ws.on('open', () => resolve({ status: 101, ws }));
    ws.on('error', (e) => resolve({ status: 0, error: e.message }));
  });
}

describe('child process environment', () => {
  test("childEnv drops KubePilot's secrets (any case) and keeps everything else", () => {
    const env = childEnv({
      KUBEPILOT_TOKEN: 't', kubepilot_token: 't', K8DASHBOARD_TOKEN: 't', K8SIGHT_TOKEN: 't',
      KUBEPILOT_SECRET_KEY: 'k', KUBEPILOT_MCP_TOKEN: 'm', MCP_API_TOKEN: 'm', LLM_API_KEY: 'l',
      KUBEPILOT_LOCAL_SHELL: '1', KUBECONFIG: '/k', AWS_PROFILE: 'dev', OPENAI_API_KEY: 'agent-key', PATH: '/bin',
    }, { EXTRA: 'x' });
    assert.deepEqual(env, {
      KUBEPILOT_LOCAL_SHELL: '1', KUBECONFIG: '/k', AWS_PROFILE: 'dev', OPENAI_API_KEY: 'agent-key', PATH: '/bin', EXTRA: 'x',
    });
    assert.equal(isAppSecretEnv('KUBEPILOT_TOKEN_FILE'), false, 'exact names only');
  });

  test('spawnBin children (kubectl, az, helm…) never inherit the token or the LLM key', async () => {
    const saved = { t: process.env.KUBEPILOT_TOKEN, l: process.env.LLM_API_KEY };
    process.env.KUBEPILOT_TOKEN = 'secret-token';
    process.env.LLM_API_KEY = 'secret-llm';
    try {
      const child = spawnBin(process.execPath, ['-e', "process.stdout.write([process.env.KUBEPILOT_TOKEN, process.env.LLM_API_KEY, process.env.EXPLICIT].join('|'))"], {
        env: { ...process.env, EXPLICIT: 'kept' },
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      await new Promise((r) => child.on('close', r));
      assert.equal(out, '||kept');
    } finally {
      for (const [k, v] of [['KUBEPILOT_TOKEN', saved.t], ['LLM_API_KEY', saved.l]]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('AI agent seed prompt quoting', () => {
  const nasty = `fix "it" & echo pwned | x > y %PATH% !X! $(whoami) \`id\` ^\nnext 'q'`;
  test('POSIX: single-quoted, read back verbatim', () => {
    assert.equal(agentPromptArg(nasty, 'linux'), shq(nasty));
    assert.equal(shq("it's"), `'it'\\''s'`);
  });
  test('Windows: one double-quoted argument with nothing cmd.exe or PowerShell would interpret', () => {
    const arg = agentPromptArg(nasty, 'win32');
    assert.match(arg, /^"[^"]*"$/);
    assert.doesNotMatch(arg.slice(1, -1), /[%!^&|<>"`$\r\n]/);
    assert.ok(arg.includes('fix  it'), arg);
  });
});

describe('server mode: host terminals are desktop-only; token stays out of production logs', () => {
  let srv;
  before(async () => {
    srv = await startServer({ env: { KUBEPILOT_DEMO: '', NODE_ENV: 'production' } });
  });
  after(async () => {
    await srv?.stop();
  });

  test('the AI agent terminal upgrade is refused (403 local_shell_disabled)', async () => {
    const r = await openWs(srv.port, 'agent=claude');
    assert.equal(r.status, 403, JSON.stringify(r));
    assert.equal(JSON.parse(r.body).code, 'local_shell_disabled');
  });

  test('launching an agent in an external terminal is refused (403)', async () => {
    const r = await srv.authed('/api/ai-agents/launch-external', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'claude' }),
    });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, 'local_shell_disabled');
  });

  test('the boot log points at scripts/login-url.mjs instead of printing the token', async () => {
    await new Promise((r) => setTimeout(r, 300));
    assert.doesNotMatch(srv.log(), new RegExp(TOKEN));
    assert.match(srv.log(), /scripts\/login-url\.mjs/);
  });
});

describe('server mode: KUBEPILOT_PRINT_LOGIN_URL=1 restores the login-URL line', () => {
  let srv;
  before(async () => {
    srv = await startServer({ env: { KUBEPILOT_DEMO: '', NODE_ENV: 'production', KUBEPILOT_PRINT_LOGIN_URL: '1' } });
  });
  after(async () => {
    await srv?.stop();
  });
  test('printed', async () => {
    await new Promise((r) => setTimeout(r, 300));
    assert.match(srv.log(), new RegExp(`#token=${TOKEN}`));
  });
});

describe('AI agent terminal — end to end (a real local shell, fake agent CLI)', () => {
  let srv, dir;
  const isWin = process.platform === 'win32';
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-agent-'));
    const kubeconfig = path.join(dir, 'config');
    fs.writeFileSync(kubeconfig, KUBECONFIG_YAML);
    // A stand-in `opencode` that reports what an agent would see.
    const probe = path.join(dir, 'probe.cjs');
    fs.writeFileSync(probe, `const fs = require('fs');
const kc = fs.readFileSync(process.env.KUBECONFIG, 'utf8');
process.stdout.write('AG' + 'ENT:' + JSON.stringify({
  context: process.env.KUBE_CONTEXT,
  dev: kc.includes('dev-cluster'),
  prod: kc.includes('prod-cluster') || kc.includes('prod-token'),
  token: Boolean(process.env.KUBEPILOT_TOKEN),
  args: process.argv.slice(2),
}) + ':E' + 'ND\\n');
`);
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    if (isWin) fs.writeFileSync(path.join(bin, 'opencode.cmd'), `@"${process.execPath}" "${probe}" %*\r\n`);
    else fs.writeFileSync(path.join(bin, 'opencode'), `#!/bin/sh\nexec "${process.execPath}" "${probe}" "$@"\n`, { mode: 0o755 });
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    srv = await startServer({
      env: {
        KUBEPILOT_DEMO: '',
        KUBEPILOT_LOCAL_SHELL: '1',
        KUBECONFIG: kubeconfig,
        [pathKey]: `${bin}${path.delimiter}${process.env[pathKey]}`,
      },
    });
  });
  after(async () => {
    await srv?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('pinned to the selected cluster, no KubePilot token, prompt passed as inert text; oversized frames refused', async () => {
    const prompt = 'why is it "Degraded"? $(echo pwned) %PATH% & echo x';
    const r = await openWs(srv.port, `agent=opencode&prompt=${encodeURIComponent(prompt)}`);
    assert.equal(r.status, 101, JSON.stringify(r));
    const { ws } = r;
    let out = '';
    ws.on('message', (d) => { out += d.toString(); });
    const end = Date.now() + 30000;
    while (!/AGENT:[^\r\n]*:END/.test(out)) {
      if (Date.now() > end) throw new Error(`timed out; got:\n${out.slice(-1500)}`);
      await new Promise((res) => setTimeout(res, 100));
    }
    const seen = JSON.parse(out.match(/AGENT:([^\r\n]*):END/)[1]);
    assert.equal(seen.context, 'dev');
    assert.equal(seen.dev, true);
    assert.equal(seen.prod, false, 'the agent must not see other clusters');
    assert.equal(seen.token, false, 'the agent must not see the KubePilot token');
    assert.equal(seen.args.length, 1, JSON.stringify(seen.args));
    if (isWin) assert.equal(seen.args[0], 'why is it  Degraded ?  (echo pwned)  PATH    echo x');
    else assert.equal(seen.args[0], prompt);
    assert.doesNotMatch(out, /pwned\r?\n.*pwned/s, 'no command substitution ran');

    // A frame over the 1 MiB cap closes the socket (1009 "message too big").
    const closed = new Promise((res) => ws.on('close', (code) => res(code)));
    ws.send(JSON.stringify({ type: 'data', data: 'x'.repeat(2 * 1024 * 1024) }));
    assert.equal(await closed, 1009);
  });
});
