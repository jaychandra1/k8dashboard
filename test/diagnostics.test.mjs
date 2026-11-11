// Audit OBS-01: the desktop app keeps a rotating log with credentials
// scrubbed (electron/diagnostics.cjs), Help → Export Diagnostics masks
// endpoints and identifiers too, and every API request carries an id that
// appears in the log and in the X-Request-Id response header.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { requestLogger } from '../lib/logger.mjs';
import { startServer, TOKEN } from './helpers/server.mjs';

const require = createRequire(import.meta.url);
const { createLogFile, diagnosticsReport, maskForReport, scrubSecrets, settingsShape } = require('../electron/diagnostics.cjs');

const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeXN0ZW06c2EifQ.c2lnbmF0dXJlLXZhbHVl';

describe('log file', () => {
  test('credentials never reach the file; lines are stamped with their source', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-log-'));
    try {
      const log = createLogFile(dir, { now: () => new Date('2026-11-07T10:00:00Z') });
      log.write('server', `K8Board listening on http://127.0.0.1:3001  —  open http://127.0.0.1:3001/#token=abcdef0123456789\n`);
      log.write('server', `{"msg":"x","detail":"Authorization: Bearer ${JWT}"}\npassword=hunter2\n\n`);
      log.write('main', 'backend exited (code 1)');
      const text = fs.readFileSync(log.file, 'utf8');
      assert.doesNotMatch(text, /abcdef0123456789|eyJhbGci|hunter2/);
      assert.match(text, /^2026-11-07T10:00:00.000Z \[server\] K8Board listening on http:\/\/127.0.0.1:3001 .*#token=\[redacted\]$/m);
      assert.match(text, /\[main\] backend exited \(code 1\)/);
      assert.equal(text.trim().split('\n').length, 4, 'blank lines are dropped');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rotates by size and keeps a bounded number of files; tail reads across the newest two', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-log-'));
    try {
      const log = createLogFile(dir, { maxBytes: 400, keep: 2 });
      for (let i = 0; i < 40; i++) log.write('server', `line ${String(i).padStart(3, '0')} ${'x'.repeat(40)}`);
      const files = fs.readdirSync(dir).sort();
      assert.deepEqual(files, ['k8board.log', 'k8board.log.1', 'k8board.log.2']);
      for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size <= 400, f);
      const tail = log.tail(10_000);
      assert.match(tail, /line 039/);
      assert.doesNotMatch(tail, /line 000/, 'old lines are gone');
      const short = log.tail(120);
      assert.ok(short.length <= 120);
      assert.match(short, /^\S+ \[server\] line/, 'starts on a whole line');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a log folder that cannot be created leaves logging off without throwing', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-log-')), 'not-a-dir');
    fs.writeFileSync(file, '');
    const log = createLogFile(path.join(file, 'logs'));
    assert.doesNotThrow(() => log.write('main', 'hello'));
    assert.equal(log.tail(), '');
  });
});

describe('diagnostics report', () => {
  test('masks endpoints, IPs, account and subscription IDs, emails and the home folder', () => {
    const home = path.join(path.sep === '\\' ? 'C:\\Users' : '/home', 'alice');
    const masked = maskForReport([
      'connect https://ABCDEF0123.gr7.us-east-1.eks.amazonaws.com failed',
      'arn:aws:eks:us-east-1:241533118296:cluster/prod and account 241533118296',
      'subscription 0f1e2d3c-4b5a-6978-8091-a2b3c4d5e6f7 node 10.0.12.7 local http://127.0.0.1:3001/api/x',
      `aks dev-abc123.hcp.westeurope.azmk8s.io user alice@example.com kubeconfig ${path.join(home, '.kube', 'config')}`,
      `token ${JWT}`,
    ].join('\n'), { home });
    for (const leak of ['ABCDEF0123', 'eks.amazonaws.com', '241533118296', '0f1e2d3c', '10.0.12.7', 'azmk8s.io', 'alice@example.com', home, 'eyJhbGci']) {
      assert.ok(!masked.includes(leak), `${leak} is masked`);
    }
    assert.match(masked, /http:\/\/127.0.0.1:3001\/api\/x/, 'loopback addresses stay');
    assert.match(masked, /~[\\/]\.kube[\\/]config/);
  });

  test('settings appear as their shape only', () => {
    assert.deepEqual(settingsShape({ mcpEnabled: true, pins: ['prod', 'dev'], recent: [], mcpAllowWrite: false, theme: 'dark', aws: { a: 1 }, n: 3 }), {
      mcpEnabled: true, pins: '[2 items]', recent: '[0 items]', mcpAllowWrite: false, theme: '(set)', aws: '{1 key}', n: 3,
    });
    assert.deepEqual(settingsShape(null), {});
  });

  test('the report has versions, the settings shape and the masked log', () => {
    const text = diagnosticsReport({
      app: { version: '1.9.0' }, system: { chrome: '142.0.7444.59' },
      settings: { pins: ['prod-241533118296'] }, log: 'failed for 241533118296 at 10.1.2.3', now: new Date('2026-11-07T00:00:00Z'),
    });
    assert.match(text, /^K8Board diagnostics\nCreated: 2026-11-07T00:00:00.000Z/);
    assert.match(text, /version: 1\.9\.0/);
    assert.match(text, /chrome: 142\.0\.7444\.59/, 'version numbers are not mistaken for IP addresses');
    assert.match(text, /"pins": "\[1 item\]"/);
    assert.match(text, /failed for \[account\] at \[ip\]/);
    assert.doesNotMatch(text, /241533118296/);
  });

  test('scrubSecrets leaves ordinary text alone', () => {
    assert.equal(scrubSecrets('GET /api/pods 200 12ms'), 'GET /api/pods 200 12ms');
  });
});

describe('request ids', () => {
  const fakeExchange = (headers = {}) => {
    const set = {};
    const listeners = {};
    const req = { method: 'GET', path: '/api/x', get: (h) => headers[h.toLowerCase()] };
    const res = { statusCode: 200, setHeader: (k, v) => { set[k] = v; }, on: (ev, fn) => { listeners[ev] = fn; } };
    return { req, res, set, finish: () => listeners.finish() };
  };

  test('each request gets an id, logged and returned; a well-formed incoming id is kept', () => {
    const lines = [];
    const log = { info: (msg, f) => lines.push(['info', f]), warn: (msg, f) => lines.push(['warn', f]) };
    const mw = requestLogger(log);

    const a = fakeExchange();
    mw(a.req, a.res, () => {});
    assert.match(a.req.id, /^[0-9a-f-]{36}$/);
    assert.equal(a.set['X-Request-Id'], a.req.id);
    a.finish();
    assert.equal(lines[0][1].requestId, a.req.id);

    const b = fakeExchange({ 'x-request-id': 'client-req-0001' });
    mw(b.req, b.res, () => {});
    assert.equal(b.req.id, 'client-req-0001');

    const c = fakeExchange({ 'x-request-id': 'bad id\nwith newline' });
    mw(c.req, c.res, () => {});
    assert.notEqual(c.req.id, 'bad id\nwith newline');

    const d = fakeExchange();
    mw(d.req, d.res, () => {});
    d.res.statusCode = 502;
    d.finish();
    assert.equal(lines.at(-1)[0], 'warn', 'server errors are logged as warnings');
  });

  test('the real server answers with X-Request-Id', async () => {
    const srv = await startServer();
    try {
      const r = await fetch(`${srv.base}/api/config/status`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      assert.equal(r.status, 200);
      assert.match(r.headers.get('x-request-id') || '', /^[0-9a-f-]{36}$/);
    } finally {
      await srv.stop();
    }
  });
});
