// Spawns server.js as a child process on a free port with an isolated HOME and
// a bearer token, waits for /healthz, and tears it down. Shared by the HTTP
// integration tests so every suite exercises the real boot path.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TOKEN = 'test-token-0123456789abcdef';

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Raw http.request wrapper: lets tests set forbidden-for-fetch headers such
// as Host, and returns the body as text.
export function rawRequest({ port, method = 'GET', path: p = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function pollHealthz(port, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const r = await rawRequest({ port, path: '/healthz' });
      if (r.status === 200 && JSON.parse(r.body).ok === true) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not become healthy on port ${port} within ${timeoutMs}ms`);
}

export async function startServer({ env = {}, timeoutMs = 20000 } = {}) {
  const port = await freePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kubepilot-test-home-'));
  const childEnv = {
    ...process.env,
    KUBEPILOT_TOKEN: TOKEN,
    PORT: String(port),
    HOST: '127.0.0.1',
    KUBECONFIG: '/nonexistent',
    HOME: home,
    USERPROFILE: home,
    NODE_ENV: 'test',
    LOG_LEVEL: 'warn',
    // The synthetic demo cluster (demo.js) is a test-only fixture, gated by
    // this flag; suites that need the product default pass KUBEPILOT_DEMO: ''.
    KUBEPILOT_DEMO: '1',
    ...env,
  };
  delete childEnv.MCP_ALLOW_WRITE;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const keep = (d) => {
    log = (log + d).slice(-8000);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);

  try {
    await pollHealthz(port, timeoutMs, child);
  } catch (err) {
    child.kill();
    throw new Error(`${err.message}\n--- server output ---\n${log}`);
  }

  const base = `http://127.0.0.1:${port}`;
  const authed = (p, init = {}) =>
    fetch(base + p, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) } });

  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill();
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* gone */
        }
        resolve();
      }, 5000).unref();
    }).finally(() => {
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    });

  return { port, base, home, child, authed, stop, log: () => log };
}
