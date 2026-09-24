// The synthetic demo cluster (demo.js) is a hidden test/dev fixture behind
// KUBEPILOT_DEMO=1. With the flag unset — the product default, and always in
// the packaged app — no demo context may be listed or enterable anywhere.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';

let srv;
before(async () => {
  srv = await startServer({ env: { KUBEPILOT_DEMO: '' } });
});
after(async () => {
  if (srv) await srv.stop();
});

const json = async (res) => JSON.parse(await res.text());

describe('demo mode is absent without KUBEPILOT_DEMO', () => {
  test('GET /api/config/status lists no demo context and reports demoAvailable: false', async () => {
    const res = await srv.authed('/api/config/status');
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.demoAvailable, false);
    assert.equal(body.loaded, false);
    assert.deepEqual(body.contexts, []);
    assert.deepEqual(body.contextsInfo, []);
    assert.ok(!JSON.stringify(body).includes('demo-cluster'));
  });

  test('GET /api/config/context lists no demo context', async () => {
    const res = await srv.authed('/api/config/context');
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.deepEqual(body.contexts, []);
    assert.notEqual(body.currentContext, 'demo-cluster');
  });

  test('POST /api/config/context {contextName: "demo-cluster"} → 400 invalid_param', async () => {
    const res = await srv.authed('/api/config/context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextName: 'demo-cluster' }),
    });
    assert.equal(res.status, 400);
    const body = await json(res);
    assert.equal(body.code, 'invalid_param');
    assert.equal(body.field, 'contextName');
    assert.match(body.error, /not found/i);

    // …and the server did not silently enter the synthetic cluster.
    const status = await json(await srv.authed('/api/config/status'));
    assert.equal(status.loaded, false);
    assert.notEqual(status.currentContext, 'demo-cluster');
  });

  test('cluster data routes are not answered by the synthetic cluster', async () => {
    // With no kubeconfig and no demo interception this must not be a 200 list
    // of sample workloads.
    const res = await srv.authed('/api/resources/default');
    assert.notEqual(res.status, 200);
  });
});
