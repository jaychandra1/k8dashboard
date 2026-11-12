// /api/app/* on the real server boot. A plain `node server.js` is not a
// Microsoft Store copy, so its update check asks nobody (the Store lookup is
// covered with a stand-in network in store-updates.test.mjs), and no copy can
// download or install an update.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';
import { ROOT_DIR } from '../lib/paths.mjs';

describe('app update routes', () => {
  let srv;
  before(async () => {
    srv = await startServer({ env: { K8BOARD_INSTALL_MANAGED_BY: '' } });
  });
  after(async () => {
    await srv?.stop();
  });

  test('state: idle with the running version; a check on a copy with no store asks nobody', async () => {
    const r = await srv.authed('/api/app/update');
    assert.equal(r.status, 200);
    const { state } = await r.json();
    assert.deepEqual(Object.keys(state).sort(), ['currentVersion', 'latest', 'managedBy', 'phase']);
    assert.deepEqual([state.phase, state.latest, state.managedBy], ['idle', null, null]);
    assert.match(state.currentVersion, /^\d+\.\d+\.\d+/);

    const c = await srv.authed('/api/app/update/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(c.status, 200);
    assert.deepEqual((await c.json()).state, { ...state, phase: 'unavailable' });
  });

  test('there is nothing to download, install or restart: those routes do not exist', async () => {
    for (const p of ['/api/app/update/download', '/api/app/update/cancel', '/api/app/update/install', '/api/app/update/restart']) {
      const r = await srv.authed(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 404, p);
    }
  });

  test("release notes: what's new in the running version first, from the app itself", async () => {
    const version = fs.readFileSync(path.join(ROOT_DIR, 'VERSION'), 'utf8').trim();
    const r = await srv.authed('/api/app/release-notes');
    assert.equal(r.status, 200);
    const notes = await r.json();
    assert.equal(notes.current, version);
    assert.ok(notes.releases.length >= 1);
    assert.deepEqual([notes.releases[0].version, notes.releases[0].current], [version, true]);
    for (const rel of notes.releases) {
      assert.ok(rel.highlights.length >= 1, rel.version);
      for (const h of rel.highlights) assert.ok(h.title && typeof h.text === 'string', rel.version);
    }
    assert.deepEqual(notes.releases.filter((x) => x.current).length, 1);
    assert.doesNotMatch(JSON.stringify(notes), /github|https?:|htmlUrl/i);
    assert.equal((await fetch(`${srv.base}/api/app/release-notes`)).status, 401);
  });

  test('requires the bearer token; MCP clients are refused', async () => {
    const anon = await fetch(`${srv.base}/api/app/update`);
    assert.equal(anon.status, 401);
    const mcp = await srv.authed('/api/app/update/check', {
      method: 'POST',
      headers: { 'X-K8Board-Source': 'mcp' },
    });
    assert.equal(mcp.status, 403);
    const notes = await srv.authed('/api/app/release-notes', { headers: { 'X-K8Board-Source': 'mcp' } });
    assert.equal(notes.status, 403);
  });
});
