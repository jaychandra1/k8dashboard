// Helm terminal (Helm page → "+ Helm terminal"): the pinned kubeconfig, the
// shell environment / command, the desktop-only gate, and — end to end — a real
// shell opened over /ws/exec?shell=helm that can only see the selected cluster.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import * as k8s from '@kubernetes/client-node';
import {
  localShellAllowed, pinnedKubeconfig, helmShellEnv, helmShellCommand, helmShellBanner, helmDirOf, clusterLabel,
} from '../lib/helm-shell.mjs';
import { startServer, TOKEN, rawRequest } from './helpers/server.mjs';

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
  context: { cluster: dev-cluster, user: dev-user, namespace: apps }
- name: prod
  context: { cluster: prod-cluster, user: prod-user }
`;

const loadKc = () => {
  const kc = new k8s.KubeConfig();
  kc.loadFromString(KUBECONFIG_YAML);
  return kc;
};

describe('helm terminal — building blocks', () => {
  test('only the desktop app (Electron) or an explicit opt-in may open a local shell', () => {
    assert.equal(localShellAllowed({ env: {}, versions: { node: '22' } }), false);
    assert.equal(localShellAllowed({ env: {}, versions: { node: '22', electron: '44.0.0' } }), true);
    assert.equal(localShellAllowed({ env: { KUBEPILOT_LOCAL_SHELL: '1' }, versions: {} }), true);
    assert.equal(localShellAllowed({ env: { KUBEPILOT_LOCAL_SHELL: 'true' }, versions: {} }), false);
  });

  test('the pinned kubeconfig holds only the selected context, its cluster and its user', () => {
    const pinned = JSON.parse(pinnedKubeconfig(loadKc(), 'prod', k8s.KubeConfig));
    assert.equal(pinned['current-context'], 'prod');
    assert.deepEqual(pinned.contexts.map((c) => c.name), ['prod']);
    assert.deepEqual(pinned.clusters.map((c) => c.name), ['prod-cluster']);
    assert.deepEqual(pinned.users.map((u) => u.name), ['prod-user']);
    const text = JSON.stringify(pinned);
    assert.ok(!text.includes('dev-cluster') && !text.includes('dev-token'), 'nothing from the other context');
    // kubectl/helm can read it back.
    const back = new k8s.KubeConfig();
    back.loadFromString(JSON.stringify(pinned));
    assert.equal(back.getCurrentCluster().server, 'https://127.0.0.1:2');
  });

  test('namespace: the given one overrides the context default; missing context throws', () => {
    assert.equal(JSON.parse(pinnedKubeconfig(loadKc(), 'dev', k8s.KubeConfig)).contexts[0].context.namespace, 'apps');
    assert.equal(JSON.parse(pinnedKubeconfig(loadKc(), 'dev', k8s.KubeConfig, 'tools')).contexts[0].context.namespace, 'tools');
    assert.throws(() => pinnedKubeconfig(loadKc(), 'staging', k8s.KubeConfig), /not in the kubeconfig/);
    assert.throws(() => pinnedKubeconfig(loadKc(), null, k8s.KubeConfig), /not in the kubeconfig/);
  });

  test('environment: allowlisted, no KubePilot secrets, pinned to the cluster', () => {
    const env = helmShellEnv({
      PATH: '/usr/bin:/bin', HOME: '/home/u', AWS_PROFILE: 'dev', HELM_CACHE_HOME: '/c', KUBECONFIG: '/home/u/.kube/config',
      KUBEPILOT_TOKEN: 'secret-token', KUBEPILOT_SECRET_KEY: 'k', NODE_OPTIONS: '--inspect', RANDOM_THING: 'x',
    }, { kubeconfigPath: '/tmp/kp-helm-1.json', context: 'arn:aws:eks:eu-west-1:1:cluster/dev', helmDir: '/opt/helm/bin', platform: 'linux' });
    assert.equal(env.KUBECONFIG, '/tmp/kp-helm-1.json');
    assert.equal(env.HELM_KUBECONTEXT, 'arn:aws:eks:eu-west-1:1:cluster/dev');
    assert.equal(env.KP_CLUSTER, 'dev');
    assert.equal(env.PATH, '/opt/helm/bin:/usr/bin:/bin');
    assert.equal(env.AWS_PROFILE, 'dev');
    assert.equal(env.HELM_CACHE_HOME, '/c');
    for (const k of ['KUBEPILOT_TOKEN', 'KUBEPILOT_SECRET_KEY', 'NODE_OPTIONS', 'RANDOM_THING', 'HELM_NAMESPACE']) assert.equal(env[k], undefined, k);
    // Windows keeps its "Path" spelling and ';' separator.
    const win = helmShellEnv({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows' }, { kubeconfigPath: 'C:\\t\\k.json', context: 'dev', namespace: 'tools', helmDir: 'C:\\helm', platform: 'win32' });
    assert.equal(win.Path, 'C:\\helm;C:\\Windows');
    assert.equal(win.PATH, undefined);
    assert.equal(win.HELM_NAMESPACE, 'tools');
    // Windows names are case-insensitive: SYSTEMROOT (as Git Bash passes it) is kept — PowerShell
    // won't start without it — and any spelling of a KubePilot secret or the pinned variables is replaced.
    const upper = helmShellEnv({ PATH: 'C:\\Windows', SYSTEMROOT: 'C:\\Windows', WINDIR: 'C:\\Windows', Kubepilot_Token: 'x', Kubeconfig: 'C:\\old' },
      { kubeconfigPath: 'C:\\t\\k.json', context: 'dev', platform: 'win32' });
    assert.equal(upper.SYSTEMROOT, 'C:\\Windows');
    assert.equal(upper.WINDIR, 'C:\\Windows');
    assert.equal(upper.PATH, 'C:\\Windows');
    assert.equal(upper.Kubepilot_Token, undefined);
    assert.equal(upper.Kubeconfig, undefined);
    assert.equal(upper.KUBECONFIG, 'C:\\t\\k.json');
  });

  test('shell: PowerShell / bash / zsh without profiles; the prompt never embeds the context name', () => {
    const w = helmShellCommand({ platform: 'win32' });
    assert.equal(w.file, 'powershell.exe');
    assert.ok(w.args.includes('-NoProfile') && w.args.includes('-NoExit'));
    assert.match(w.args.at(-1), /\$env:KP_CLUSTER/);
    const b = helmShellCommand({ platform: 'linux', exists: (f) => f === '/bin/bash' });
    assert.deepEqual([b.file, ...b.args], ['/bin/bash', '--noprofile', '--norc', '-i']);
    assert.equal(b.env.PS1, '[helm:${KP_CLUSTER}] \\W \\$ ');
    const z = helmShellCommand({ platform: 'darwin', exists: (f) => f === '/bin/zsh' });
    assert.deepEqual([z.file, ...z.args], ['/bin/zsh', '-f', '-i']);
    assert.equal(helmShellCommand({ platform: 'linux', exists: () => false }).file, '/bin/sh');
  });

  test('banner: names the cluster; a missing helm gets the install command for the OS', () => {
    const ok = helmShellBanner({ context: 'ctx/dev', helmFound: true, platform: 'linux' });
    assert.match(ok, /Helm terminal/);
    assert.match(ok, /can only reach ctx\/dev/);
    assert.match(ok, /helm install trivy-operator/);
    assert.match(helmShellBanner({ context: 'dev', helmFound: false, platform: 'win32' }), /winget install Helm\.Helm/);
    assert.match(helmShellBanner({ context: 'dev', helmFound: false, platform: 'darwin' }), /brew install helm/);
    assert.equal(helmDirOf('helm'), null);
    assert.equal(helmDirOf(path.resolve('bin', 'helm')), path.resolve('bin'));
    assert.equal(clusterLabel('arn:aws:eks:x:1:cluster/prod-eu'), 'prod-eu');
  });
});

// Upgrade a /ws/exec URL; resolve with the HTTP status of a refusal, or the socket.
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

describe('helm terminal — off outside the desktop app', () => {
  let srv;
  before(async () => { srv = await startServer({ env: { KUBEPILOT_DEMO: '' } }); });
  after(async () => { await srv?.stop(); });

  test('GET /api/helm-terminal says desktop_only and the upgrade is refused (403)', async () => {
    const info = await (await srv.authed('/api/helm-terminal')).json();
    assert.equal(info.available, false);
    assert.equal(info.reason, 'desktop_only');
    const r = await openWs(srv.port, 'shell=helm');
    assert.equal(r.status, 403, JSON.stringify(r));
    assert.equal(JSON.parse(r.body).code, 'local_shell_disabled');
  });

  test('only shell=helm is accepted, and the token is required', async () => {
    const bad = await openWs(srv.port, 'shell=bash');
    assert.equal(bad.status, 400);
    assert.equal(JSON.parse(bad.body).field, 'shell');
    const anon = await rawRequest({ port: srv.port, path: '/api/helm-terminal' });
    assert.equal(anon.status, 401);
  });
});

describe('helm terminal — end to end (a real local shell)', () => {
  let srv, dir;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-helm-shell-'));
    const kubeconfig = path.join(dir, 'config');
    fs.writeFileSync(kubeconfig, KUBECONFIG_YAML);
    srv = await startServer({ env: { KUBEPILOT_DEMO: '', KUBEPILOT_LOCAL_SHELL: '1', KUBECONFIG: kubeconfig } });
  });
  after(async () => {
    await srv?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the shell sees only the selected cluster, and no KubePilot token', async () => {
    const info = await (await srv.authed('/api/helm-terminal')).json();
    assert.equal(info.available, true, JSON.stringify(info));
    assert.equal(info.context, 'dev');

    const tempKubeconfigs = () => new Set(fs.readdirSync(os.tmpdir()).filter((f) => /^kp-helm-.*\.json$/.test(f)));
    const before = tempKubeconfigs();
    const r = await openWs(srv.port, 'shell=helm');
    assert.equal(r.status, 101, JSON.stringify(r));
    const { ws } = r;
    let out = '';
    ws.on('message', (d) => { out += d.toString(); });
    const waitFor = async (re, ms = 30000) => {
      const end = Date.now() + ms;
      while (!re.test(out)) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${re}; got:\n${out.slice(-1500)}`);
        await new Promise((res) => setTimeout(res, 100));
      }
    };
    try {
      await waitFor(/Helm terminal/);
      await waitFor(/\[helm:dev\]/); // the prompt
      // node is on PATH in tests; the same command works in PowerShell and bash. The
      // marker is split in the command so only the output (not the echo) matches.
      const probe = "node -p \"'PRO' + 'BE:' + process.env.HELM_KUBECONTEXT + '|' + require('fs').readFileSync(process.env.KUBECONFIG, 'utf8').includes('prod-cluster') + '|' + (process.env.KUBEPILOT_TOKEN ? 'leak' : 'clean') + ':E' + 'ND'\"";
      ws.send(JSON.stringify({ type: 'data', data: `${probe}\r` }));
      await waitFor(/PROBE:[^\r\n]*:END/);
      const line = out.match(/PROBE:([^\r\n]*):END/g).at(-1);
      assert.equal(line, 'PROBE:dev|false|clean:END');
    } finally {
      ws.close();
    }
    // The temporary kubeconfig this session created exists while open and is removed on close.
    await new Promise((res) => setTimeout(res, 1500));
    assert.deepEqual([...tempKubeconfigs()].filter((f) => !before.has(f)), []);
  });
});
