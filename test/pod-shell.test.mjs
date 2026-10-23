// The pod terminal without kubectl: an interactive TTY session over the
// Kubernetes API, end to end — browser WebSocket → server.js → client-node's
// exec WebSocket → a fake API server speaking the v4 channel protocol
// (channel 0 stdin, 1 stdout, 3 status, 4 resize). Keystrokes, output,
// resizes sent before the session is ready, the exit code and the default
// container all have to make it through.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { startServer, TOKEN } from './helpers/server.mjs';

function fakeKubeApi() {
  const sessions = [];
  const server = http.createServer((req, res) => {
    // readNamespacedPod for the default-container lookup.
    if (req.method === 'GET' && req.url.startsWith('/api/v1/namespaces/apps/pods/multi')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        apiVersion: 'v1', kind: 'Pod',
        metadata: { name: 'multi', namespace: 'apps', annotations: { 'kubectl.kubernetes.io/default-container': 'app' } },
        spec: { containers: [{ name: 'sidecar', image: 'x' }, { name: 'app', image: 'y' }] },
      }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"kind":"Status","code":404}');
  });
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has('v4.channel.k8s.io') ? 'v4.channel.k8s.io' : false),
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (!/^\/api\/v1\/namespaces\/apps\/pods\/[^/]+\/exec$/.test(url.pathname)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const session = { query: url.searchParams, input: '' };
      sessions.push(session);
      const out = (text) => ws.send(Buffer.concat([Buffer.from([1]), Buffer.from(text)]));
      out('$ ');
      ws.on('message', (frame) => {
        const buf = Buffer.from(frame);
        const channel = buf[0];
        const body = buf.subarray(1).toString('utf8');
        if (channel === 4) {
          const { width, height } = JSON.parse(body);
          out(`SIZE:${width}x${height}\r\n`);
        } else if (channel === 0) {
          session.input += body;
          if (session.input.includes('exit\r')) {
            ws.send(Buffer.concat([Buffer.from([3]), Buffer.from(JSON.stringify({
              metadata: {}, status: 'Failure', reason: 'NonZeroExitCode',
              details: { causes: [{ reason: 'ExitCode', message: '3' }] },
            }))]));
            ws.close();
          } else if (body.endsWith('\r')) {
            out(`ECHO:${session.input.split('\r').at(-2)} — ünïcødé ✓\r\n$ `);
          }
        }
      });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, sessions })));
}

describe('pod terminal without kubectl (over the Kubernetes API)', () => {
  let srv, kube, dir;
  before(async () => {
    kube = await fakeKubeApi();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-podshell-'));
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
    srv = await startServer({ env: { KUBEPILOT_DEMO: '', KUBECONFIG: kubeconfig, KUBEPILOT_KUBECTL_BIN: '/nonexistent/kubectl' } });
  });
  after(async () => {
    await srv?.stop();
    kube?.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const open = (query) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws/exec?token=${TOKEN}&${query}`, { origin: `http://127.0.0.1:${srv.port}` });
    const state = { ws, out: '', closed: false };
    ws.on('message', (d) => { state.out += d.toString(); });
    ws.on('close', () => { state.closed = true; });
    ws.on('open', () => resolve(state));
    ws.on('error', reject);
    ws.on('unexpected-response', (req, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
  });
  const waitFor = async (state, cond, what) => {
    const end = Date.now() + 15000;
    while (!cond()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}; output:\n${state.out}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  test('keystrokes, output (UTF-8), early resize and exit code round-trip; exec asks for a TTY', async () => {
    const t = await open('namespace=apps&pod=web-0&container=web');
    // Sent at once — before the API session is ready — so they are replayed.
    t.ws.send(JSON.stringify({ type: 'resize', cols: 132, rows: 40 }));
    t.ws.send(JSON.stringify({ type: 'data', data: 'echo hi\r' }));
    await waitFor(t, () => /ECHO:echo hi — ünïcødé ✓/.test(t.out), 'echo');
    assert.match(t.out, /built-in Kubernetes client/);
    // Resizes travel on their own channel, so they may land after the echo.
    await waitFor(t, () => /SIZE:132x40/.test(t.out), 'replayed resize');
    t.ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    await waitFor(t, () => /SIZE:100x30/.test(t.out), 'resize');
    t.ws.send(JSON.stringify({ type: 'data', data: 'exit\r' }));
    await waitFor(t, () => t.closed, 'close');
    assert.match(t.out, /\[process exited with code 3\]/);

    const q = kube.sessions[0].query;
    assert.equal(q.get('tty'), 'true');
    assert.equal(q.get('stdin'), 'true');
    assert.equal(q.get('stderr'), 'false', 'a TTY merges stderr into stdout');
    assert.equal(q.get('container'), 'web');
    assert.deepEqual(q.getAll('command'), ['sh', '-c', 'exec $(command -v bash || command -v sh || echo /bin/sh)']);
  });

  test("without a container the pod's default container is used (kubectl's rule)", async () => {
    const t = await open('namespace=apps&pod=multi');
    await waitFor(t, () => kube.sessions.length === 2, 'second session');
    assert.equal(kube.sessions[1].query.get('container'), 'app');
    t.ws.close();
  });

  test('a pod that is gone says so plainly', async () => {
    const t = await open('namespace=apps&pod=gone-0');
    await waitFor(t, () => t.closed, 'close');
    assert.match(t.out, /Could not open a shell in gone-0: The pod or container no longer exists \(HTTP 404\)\./);
  });
});
