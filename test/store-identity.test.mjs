// The Microsoft Store identity (name, publisher) comes from the environment
// (repository variables in CI), never from the repository; the publisher
// display name is in package.json: scripts/store-identity.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { storeIdentity, identityArgs, appxConfig, storePackageName, STORE_ENV, RETIRED_DISPLAY_NAME_ENV } from '../scripts/store-identity.mjs';
import { ROOT_DIR } from '../lib/paths.mjs';

const FULL = { MS_STORE_IDENTITY_NAME: 'Example.App', MS_STORE_PUBLISHER: 'CN=00000000-0000-0000-0000-000000000000' };

test('both values, none, or a clear error', () => {
  assert.equal(storeIdentity({}), null);
  assert.deepEqual(storeIdentity(FULL), { identityName: 'Example.App', publisher: FULL.MS_STORE_PUBLISHER });
  assert.throws(() => storeIdentity({ MS_STORE_IDENTITY_NAME: 'Example.App' }), /all of/);
  assert.throws(() => storeIdentity({ ...FULL, MS_STORE_PUBLISHER: '2A0B-not-a-cn' }), /CN=/);
  assert.throws(() => storeIdentity({ ...FULL, MS_STORE_IDENTITY_NAME: 'has spaces' }), /identity name/);
  assert.equal(storeIdentity({ [RETIRED_DISPLAY_NAME_ENV]: 'Someone' }), null, 'the display name is not read from the environment');
});

test("package.json's placeholders are refused as values", () => {
  const appx = appxConfig();
  assert.throws(() => storeIdentity({ ...FULL, MS_STORE_IDENTITY_NAME: appx.identityName }), /placeholder from package\.json/);
  assert.throws(() => storeIdentity({ ...FULL, MS_STORE_PUBLISHER: appx.publisher }), /placeholder from package\.json/);
});

test('passed to electron-builder as overrides of the package.json placeholders', () => {
  assert.deepEqual(identityArgs(storeIdentity(FULL)), [
    '-c.appx.identityName=Example.App',
    `-c.appx.publisher=${FULL.MS_STORE_PUBLISHER}`,
    '-c.appx.artifactName=K8Board-windows-store.msix',
  ]);
  assert.deepEqual(identityArgs(null), []);
  const appx = appxConfig(ROOT_DIR);
  assert.deepEqual([appx.identityName, appx.publisher], ['K8Board.Desktop', 'CN=K8Board'], 'only placeholders for the identity in the repository');
  assert.equal(appx.publisherDisplayName, 'JDG Initiates', "the Partner Center account's publisher display name");
});

test('only a package with the identity gets the name to upload', () => {
  assert.equal(storePackageName(ROOT_DIR), 'K8Board-windows-store.msix');
  assert.equal(appxConfig(ROOT_DIR).artifactName, '${productName}-windows-store-placeholder.msix', 'any other build is visibly a placeholder');
});

test('a Store build without the identity refuses to run', () => {
  const env = { ...process.env };
  for (const name of Object.values(STORE_ENV)) delete env[name];
  const r = spawnSync(process.execPath, [path.join(ROOT_DIR, 'scripts', 'store-identity.mjs'), '--win', 'appx'], { env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Store identity isn't set/);
});
