// The Microsoft Store identity comes from the environment (repository
// variables in CI), never from the repository: scripts/store-identity.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { storeIdentity, identityArgs, STORE_ENV } from '../scripts/store-identity.mjs';
import { ROOT_DIR } from '../lib/paths.mjs';

const FULL = { MS_STORE_IDENTITY_NAME: 'Example.App', MS_STORE_PUBLISHER: 'CN=00000000-0000-0000-0000-000000000000', MS_STORE_PUBLISHER_DISPLAY_NAME: 'Example Publisher' };

test('all three values, none, or a clear error', () => {
  assert.equal(storeIdentity({}), null);
  assert.deepEqual(storeIdentity(FULL), { identityName: 'Example.App', publisher: FULL.MS_STORE_PUBLISHER, publisherDisplayName: 'Example Publisher' });
  assert.throws(() => storeIdentity({ MS_STORE_IDENTITY_NAME: 'Example.App' }), /all of/);
  assert.throws(() => storeIdentity({ ...FULL, MS_STORE_PUBLISHER: '2A0B-not-a-cn' }), /CN=/);
  assert.throws(() => storeIdentity({ ...FULL, MS_STORE_IDENTITY_NAME: 'has spaces' }), /identity name/);
});

test('passed to electron-builder as overrides of the package.json placeholders', () => {
  assert.deepEqual(identityArgs(storeIdentity(FULL)), [
    '-c.appx.identityName=Example.App',
    `-c.appx.publisher=${FULL.MS_STORE_PUBLISHER}`,
    '-c.appx.publisherDisplayName=Example Publisher',
  ]);
  assert.deepEqual(identityArgs(null), []);
  const appx = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).build.appx;
  assert.deepEqual([appx.identityName, appx.publisher, appx.publisherDisplayName], ['K8Board.Desktop', 'CN=K8Board', 'K8Board Program'], 'only placeholders in the repository');
});

test('a Store build without the identity refuses to run', () => {
  const env = { ...process.env };
  for (const name of Object.values(STORE_ENV)) delete env[name];
  const r = spawnSync(process.execPath, [path.join(ROOT_DIR, 'scripts', 'store-identity.mjs'), '--win', 'appx'], { env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Store identity isn't set/);
});
