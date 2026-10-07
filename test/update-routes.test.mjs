// /api/app/* on the real server boot. Only routes that never reach GitHub are
// exercised here (the release service itself is covered with a mocked fetch
// in updater.test.mjs); a plain `node server.js` has no desktop host, so it
// can check for updates but never download or install one.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';

describe('app update routes', () => {
  let srv;
  before(async () => {
    srv = await startServer({ env: { KUBEPILOT_INSTALL_KIND: '', KUBEPILOT_UPDATE_DIR: '' } });
  });
  after(async () => {
    await srv?.stop();
  });

  test('state: idle, with the running version and no way to install from a dev server', async () => {
    const r = await srv.authed('/api/app/update');
    assert.equal(r.status, 200);
    const { state } = await r.json();
    assert.equal(state.phase, 'idle');
    assert.match(state.currentVersion, /^\d+\.\d+\.\d+/);
    assert.equal(state.canInstall, false);
    assert.match(state.installUnavailable, /desktop app/);
  });

  test('download / install / restart before a check are refused (409), nothing runs', async () => {
    for (const p of ['/api/app/update/download', '/api/app/update/install', '/api/app/update/restart']) {
      const r = await srv.authed(p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(r.status, 409, p);
      assert.equal((await r.json()).code, 'invalid_state', p);
    }
    const c = await srv.authed('/api/app/update/cancel', { method: 'POST' });
    assert.equal(c.status, 200);
  });

  test('requires the bearer token; MCP clients are refused', async () => {
    const anon = await fetch(`${srv.base}/api/app/update`);
    assert.equal(anon.status, 401);
    const mcp = await srv.authed('/api/app/update/check', {
      method: 'POST',
      headers: { 'X-KubePilot-Source': 'mcp' },
    });
    assert.equal(mcp.status, 403);
    const notes = await srv.authed('/api/app/release-notes', { headers: { 'X-KubePilot-Source': 'mcp' } });
    assert.equal(notes.status, 403);
  });
});
