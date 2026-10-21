#!/usr/bin/env node
// One-time setup of the release-signing key (see lib/updater/keys.mjs).
//
//   node scripts/release-signing-keygen.mjs [--out <file>] [--no-write]
//
// Generates an Ed25519 key pair, writes the PRIVATE key (PKCS#8 PEM, mode
// 0600) to --out — by default ~/.kubepilot-release/release-signing-key.pem,
// outside the repository — and adds the PUBLIC key to RELEASE_PUBLIC_KEYS in
// lib/updater/keys.mjs (--no-write only prints it). It never overwrites an
// existing key file.
//
// Then store the private key as the RELEASE_SIGNING_KEY secret of the GitHub
// `release` environment, keep an offline backup of the file, and commit
// lib/updater/keys.mjs. Every app version built from then on refuses updates
// that aren't signed with this key, so losing it means shipping a release that
// trusts a new key before the old one can be retired.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keysFile = path.join(repo, 'lib', 'updater', 'keys.mjs');

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const out = path.resolve(
  outIdx >= 0 && args[outIdx + 1]
    ? args[outIdx + 1]
    : path.join(os.homedir(), '.kubepilot-release', 'release-signing-key.pem')
);
const write = !args.includes('--no-write');

if (fs.existsSync(out)) {
  console.error(`✗ ${out} already exists — refusing to overwrite a signing key.`);
  process.exit(1);
}
// Real (long-name, symlink-free) path of `p`, which need not exist yet.
const realPath = (p) => {
  const rest = [];
  let dir = path.resolve(p);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) {
    rest.unshift(path.basename(dir));
    dir = path.dirname(dir);
  }
  return path.join(fs.realpathSync.native(dir), ...rest);
};
const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const rel = path.relative(fold(realPath(repo)), fold(realPath(out)));
if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
  console.error('✗ Keep the private key outside the repository (use --out <path outside the repo>).');
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
fs.writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });

if (write) {
  const src = fs.readFileSync(keysFile, 'utf8');
  const re = /export const RELEASE_PUBLIC_KEYS = \[([\s\S]*?)\];/;
  const m = src.match(re);
  if (!m) {
    console.error(`✗ Could not find RELEASE_PUBLIC_KEYS in ${keysFile}; add this key by hand:\n  '${pub}'`);
    process.exit(1);
  }
  const existing = m[1]
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const list = [...existing.map((l) => (l.endsWith(',') ? l : `${l},`)), `'${pub}',`];
  fs.writeFileSync(keysFile, src.replace(re, () => `export const RELEASE_PUBLIC_KEYS = [\n  ${list.join('\n  ')}\n];`));
}

console.log(`✓ Private key written to ${out} (keep it secret; back it up offline)`);
console.log(`✓ Public key${write ? ' added to lib/updater/keys.mjs' : ''}: ${pub}`);
console.log('\nNext:');
console.log(`  gh secret set RELEASE_SIGNING_KEY --env release < "${out}"`);
if (write) console.log('  git add lib/updater/keys.mjs && git commit -m "release: trust release-signing key"');
