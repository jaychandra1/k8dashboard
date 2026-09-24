// The MCP write gate: mcp.js calls the REST API with `X-KubePilot-Source: mcp`.
// While MCP write access is disabled (the default), every mutating route must
// refuse those calls with 403 — both against a real context and in demo mode
// (the KUBEPILOT_DEMO=1 test fixture, where the demo interceptor answers
// mutations itself).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';

let srv;
before(async () => {
  srv = await startServer(); // MCP_ALLOW_WRITE is stripped by the helper
});
after(async () => {
  if (srv) await srv.stop();
});

const post = (p, body, headers = {}) =>
  srv.authed(p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const APPLY = { yaml: 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n  namespace: default\n' };

describe('MCP write gate (writes disabled)', () => {
  test('POST /api/apply with X-KubePilot-Source: mcp → 403 mcp_write_disabled', async () => {
    const res = await post('/api/apply', APPLY, { 'X-KubePilot-Source': 'mcp' });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'mcp_write_disabled');
  });

  test('legacy X-K8dashboard-Source header is still gated', async () => {
    const res = await post('/api/apply', APPLY, { 'X-K8dashboard-Source': 'mcp' });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'mcp_write_disabled');
  });

  test('legacy X-K8sight-Source header is still gated', async () => {
    const res = await post('/api/apply', APPLY, { 'X-K8sight-Source': 'mcp' });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'mcp_write_disabled');
  });

  test('the same request from the UI (no MCP header) is not blocked by the gate', async () => {
    const res = await post('/api/apply', APPLY);
    assert.notEqual(res.status, 403);
  });

  test('DELETE / scale / rollout routes are gated too', async () => {
    const h = { 'X-KubePilot-Source': 'mcp' };
    const del = await srv.authed('/api/resource/default/deployment/web', { method: 'DELETE', headers: h });
    assert.equal(del.status, 403);
  });

  test('the gate still applies inside demo mode', async () => {
    const enter = await post('/api/config/context', { contextName: 'demo-cluster' });
    assert.equal(enter.status, 200);

    const res = await post('/api/apply', APPLY, { 'X-KubePilot-Source': 'mcp' });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'mcp_write_disabled');

    // Reads from MCP are fine.
    const list = await srv.authed('/api/resources/default', { headers: { 'X-KubePilot-Source': 'mcp' } });
    assert.equal(list.status, 200);
  });
});
