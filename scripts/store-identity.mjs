#!/usr/bin/env node
// The Microsoft Store package identity (Partner Center → Product management →
// Product identity) is not kept in the repository. Builds read it from:
//   MS_STORE_IDENTITY_NAME            Package/Identity/Name
//   MS_STORE_PUBLISHER                Package/Identity/Publisher (CN=…)
//   MS_STORE_PUBLISHER_DISPLAY_NAME   Package/Properties/PublisherDisplayName
// (GitHub Actions: repository variables of the same names; locally: environment
// variables) and hand it to electron-builder, overriding the placeholders in
// package.json build.appx. Only the MSIX uses it.
//
//   node scripts/store-identity.mjs [--allow-placeholder] [electron-builder args…]
//   e.g. node scripts/store-identity.mjs --win appx --publish never
// Without the variables it refuses (the package would carry placeholders that
// Partner Center rejects) unless --allow-placeholder is given (release builds:
// the installers don't need the identity; the Store job checks it).
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const STORE_ENV = Object.freeze({
  identityName: 'MS_STORE_IDENTITY_NAME',
  publisher: 'MS_STORE_PUBLISHER',
  publisherDisplayName: 'MS_STORE_PUBLISHER_DISPLAY_NAME',
});

/** The identity from the environment, null when none of it is set. Throws when it is half set or malformed. */
export function storeIdentity(env = process.env) {
  const id = Object.fromEntries(Object.entries(STORE_ENV).map(([key, name]) => [key, String(env[name] ?? '').trim()]));
  const set = Object.values(id).filter(Boolean).length;
  if (set === 0) return null;
  if (set < 3) throw new Error(`Set all of ${Object.values(STORE_ENV).join(', ')}, or none of them.`);
  if (!/^CN=\S/.test(id.publisher)) throw new Error(`${STORE_ENV.publisher} must be Partner Center's Package/Identity/Publisher, starting with "CN=".`);
  if (!/^[A-Za-z0-9.-]{3,50}$/.test(id.identityName)) throw new Error(`${STORE_ENV.identityName} doesn't look like a package identity name.`);
  return id;
}

/** electron-builder overrides for an identity (none for null). */
export const identityArgs = (id) => (id
  ? [`-c.appx.identityName=${id.identityName}`, `-c.appx.publisher=${id.publisher}`, `-c.appx.publisherDisplayName=${id.publisherDisplayName}`]
  : []);

function main(argv) {
  const allowPlaceholder = argv.includes('--allow-placeholder');
  const args = argv.filter((a) => a !== '--allow-placeholder');
  let id;
  try { id = storeIdentity(); } catch (e) { console.error(`✗ ${e.message}`); return 1; }
  if (!id && !allowPlaceholder) {
    console.error(`✗ The Store identity isn't set: ${Object.values(STORE_ENV).join(', ')}.`);
    console.error('  Copy the three values from Partner Center → Product management → Product identity.');
    return 1;
  }
  console.log(id ? `  • Store identity from the environment: ${id.identityName}` : '  • no Store identity set: the MSIX keeps the placeholders (not uploadable)');
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const cli = createRequire(path.join(root, 'package.json')).resolve('electron-builder/cli.js');
  const r = spawnSync(process.execPath, [cli, ...args, ...identityArgs(id)], { stdio: 'inherit', cwd: root });
  return r.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
