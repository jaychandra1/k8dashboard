// End-to-end HTTP tests against a real `node server.js` child process
// (KUBEPILOT_TOKEN fixed, KUBECONFIG=/nonexistent, isolated HOME, free port,
// KUBEPILOT_DEMO=1 so the synthetic demo cluster is available as a fixture).
// Covers the auth gate, the Host allowlist, path-case handling, body-size and
// parse errors, input validation on mutating routes, security headers and the
// WebSocket upgrade.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer, rawRequest, TOKEN } from './helpers/server.mjs';

let srv;
before(async () => {
  srv = await startServer();
});
after(async () => {
  if (srv) await srv.stop();
});

const json = async (res) => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`expected JSON, got: ${text.slice(0, 200)}`);
  }
};

describe('liveness & auth', () => {
  test('GET /healthz is public and reports ok/version/uptime', async () => {
    const res = await fetch(`${srv.base}/healthz`);
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, 'string');
    assert.equal(typeof body.uptime, 'number');
  });

  test('GET /api/version is public', async () => {
    const res = await fetch(`${srv.base}/api/version`);
    assert.equal(res.status, 200);
  });

  test('GET /api/config/status → 401 without a token, 200 with it', async () => {
    const anon = await fetch(`${srv.base}/api/config/status`);
    assert.equal(anon.status, 401);
    const body = await json(anon);
    assert.equal(typeof body.error, 'string');

    const wrong = await fetch(`${srv.base}/api/config/status`, { headers: { Authorization: 'Bearer nope' } });
    assert.equal(wrong.status, 401);

    const ok = await srv.authed('/api/config/status');
    assert.equal(ok.status, 200);
  });

  test('token in a query string does not authenticate REST calls', async () => {
    const res = await fetch(`${srv.base}/api/config/status?token=${TOKEN}`);
    assert.equal(res.status, 401);
  });

  test('POST /mcp requires the token too', async () => {
    const res = await fetch(`${srv.base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(res.status, 401);
  });
});

describe('host allowlist & routing', () => {
  test('Host: evil.example → 421 (DNS rebinding)', async () => {
    const r = await rawRequest({ port: srv.port, path: '/healthz', headers: { Host: 'evil.example' } });
    assert.equal(r.status, 421);
    const r2 = await rawRequest({
      port: srv.port,
      path: '/api/config/status',
      headers: { Host: `evil.example:${srv.port}`, Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(r2.status, 421, 'even with a valid token');
  });

  test('loopback Host variants are accepted', async () => {
    for (const host of [`localhost:${srv.port}`, `127.0.0.1:${srv.port}`, `[::1]:${srv.port}`]) {
      const r = await rawRequest({ port: srv.port, path: '/healthz', headers: { Host: host } });
      assert.equal(r.status, 200, host);
    }
  });

  test('/API/version (wrong case) → 404, never a bypass', async () => {
    const r = await fetch(`${srv.base}/API/version`);
    assert.equal(r.status, 404);
    const r2 = await fetch(`${srv.base}/Api/config/status`);
    assert.equal(r2.status, 404);
  });

  test('cross-origin browser requests to /api are rejected', async () => {
    const res = await srv.authed('/api/config/status', { headers: { Origin: 'http://evil.example' } });
    assert.equal(res.status, 403);
  });
});

describe('request bodies', () => {
  test('a 200 kB malformed JSON body to /api/apply yields a JSON error, not HTML', async () => {
    const body = '{"yaml":"' + 'x'.repeat(200 * 1024) + '"'; // unterminated object
    const res = await srv.authed('/api/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const parsed = await json(res);
    assert.equal(typeof parsed.error, 'string');
    assert.doesNotMatch(parsed.error, /<html/i);
  });

  test('an over-limit body → 413 as JSON', async () => {
    const body = JSON.stringify({ yaml: 'x'.repeat(5 * 1024 * 1024) });
    const res = await srv.authed('/api/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(res.status, 413);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const parsed = await json(res);
    assert.equal(typeof parsed.error, 'string');
  });
});

describe('demo mode (KUBEPILOT_DEMO=1) & input validation', () => {
  test('the status endpoint advertises the fixture when the flag is set', async () => {
    const res = await srv.authed('/api/config/status');
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.demoAvailable, true);
    assert.ok(body.contexts.includes('demo-cluster'));
  });

  test('entering the demo context works without a kubeconfig', async () => {
    const res = await srv.authed('/api/config/context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextName: 'demo-cluster' }),
    });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.currentContext, 'demo-cluster');

    const list = await srv.authed('/api/resources/default');
    assert.equal(list.status, 200);
  });

  test('a flag-shaped context name is rejected', async () => {
    const res = await srv.authed('/api/config/context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextName: '--kubeconfig=/etc/passwd' }),
    });
    assert.equal(res.status, 400);
  });

  test('DELETE /api/resource/default/deployment/--all → 400', async () => {
    const res = await srv.authed('/api/resource/default/deployment/--all', { method: 'DELETE' });
    assert.equal(res.status, 400);
    const body = await json(res);
    assert.equal(typeof body.error, 'string');
  });

  test('flag-shaped namespace / kind segments are rejected', async () => {
    for (const p of ['/api/resources/--all', '/api/resource/default/--all/x', '/api/resources/a%20b']) {
      const res = await srv.authed(p);
      assert.equal(res.status, 400, p);
    }
  });

  test('POST /api/config/load refuses an arbitrary system file', async () => {
    const filePath = process.platform === 'win32' ? 'C:/Windows/win.ini' : '/etc/hosts';
    const res = await srv.authed('/api/config/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath }),
    });
    assert.ok([400, 403].includes(res.status), `expected 400/403, got ${res.status}`);
    const body = await json(res);
    assert.equal(typeof body.error, 'string');
    // and nothing was loaded
    const status = await json(await srv.authed('/api/config/status'));
    assert.notEqual(status.kubeconfigPath, filePath);
  });

  test('relative / empty filePath → 400', async () => {
    for (const filePath of ['', 'relative/config', 42, null]) {
      const res = await srv.authed('/api/config/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath }),
      });
      assert.equal(res.status, 400, JSON.stringify(filePath));
    }
  });
});

describe('security headers', () => {
  test('X-Content-Type-Options / X-Frame-Options / Referrer-Policy on every response; no X-Powered-By', async () => {
    for (const p of ['/healthz', '/', '/api/version']) {
      const res = await fetch(`${srv.base}${p}`);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', p);
      assert.equal(res.headers.get('x-frame-options'), 'DENY', p);
      assert.ok(res.headers.get('referrer-policy'), `${p} referrer-policy`);
      assert.equal(res.headers.get('x-powered-by'), null, `${p} must not advertise Express`);
    }
  });

  test('Content-Security-Policy on the UI document, Cache-Control: no-store on the API', async () => {
    const ui = await fetch(`${srv.base}/`);
    const csp = ui.headers.get('content-security-policy') || '';
    // With client/dist built this is the UI document's policy (default-src 'self');
    // without it the server answers with an even stricter default-src 'none'.
    assert.match(csp, /default-src '(self|none)'/);
    assert.doesNotMatch(csp, /unsafe-eval/);

    const api = await srv.authed('/api/config/status');
    assert.equal(api.headers.get('cache-control'), 'no-store');
  });
});

describe('WebSocket /ws/exec', () => {
  const upgrade = (url) =>
    new Promise((resolve) => {
      const ws = new WebSocket(url, { handshakeTimeout: 5000 });
      ws.on('unexpected-response', (_req, res) => {
        resolve({ status: res.statusCode });
        ws.terminate();
      });
      ws.on('open', () => {
        resolve({ status: 101 });
        ws.close();
      });
      ws.on('error', (err) => resolve({ status: 0, err }));
    });

  test('upgrade without a token → 401', async () => {
    const r = await upgrade(`ws://127.0.0.1:${srv.port}/ws/exec?namespace=default&pod=x&container=y`);
    assert.equal(r.status, 401, `expected 401, got ${r.status} ${r.err ? r.err.message : ''}`);
  });

  test('upgrade with a wrong token → 401', async () => {
    const r = await upgrade(
      `ws://127.0.0.1:${srv.port}/ws/exec?token=wrong&namespace=default&pod=x&container=y`
    );
    assert.equal(r.status, 401);
  });

  test('upgrade with ?token= is accepted', async () => {
    const r = await upgrade(
      `ws://127.0.0.1:${srv.port}/ws/exec?token=${TOKEN}&namespace=default&pod=x&container=y`
    );
    assert.equal(r.status, 101, `expected 101, got ${r.status} ${r.err ? r.err.message : ''}`);
  });

  test('cross-origin upgrade is refused even with a token', async () => {
    const r = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws/exec?token=${TOKEN}`, {
        headers: { Origin: 'http://evil.example' },
        handshakeTimeout: 5000,
      });
      ws.on('unexpected-response', (_req, res) => {
        resolve(res.statusCode);
        ws.terminate();
      });
      ws.on('open', () => {
        resolve(101);
        ws.close();
      });
      ws.on('error', () => resolve(0));
    });
    assert.notEqual(r, 101);
  });
});
