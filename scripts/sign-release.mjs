#!/usr/bin/env node
// Sign a release's checksum list (run by .github/workflows/release.yml).
//
//   node scripts/sign-release.mjs <dir> <version>   writes <dir>/SHA256SUMS.txt.sig
//   node scripts/sign-release.mjs --check           only checks the key (no files)
//
// The Ed25519 private key (PKCS#8 PEM) comes from RELEASE_SIGNING_KEY. Both
// modes fail unless that key matches one of RELEASE_PUBLIC_KEYS in
// lib/updater/keys.mjs — a release the app wouldn't accept is never published —
// and the signature is verified with the app's own code before it is kept.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RELEASE_PUBLIC_KEYS } from '../lib/updater/keys.mjs';
import { CHECKSUMS_ASSET, SIGNATURE_ASSET, signedMessage, verifyChecksumsSignature } from '../lib/updater/verify.mjs';
import { normalizeVersion } from '../lib/updater/version.mjs';

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

if (!RELEASE_PUBLIC_KEYS.length) {
  fail(
    'lib/updater/keys.mjs trusts no release-signing key yet. Run `node scripts/release-signing-keygen.mjs` ' +
      'once, store the private key as the RELEASE_SIGNING_KEY secret of the `release` environment and commit keys.mjs.'
  );
}
const pem = String(process.env.RELEASE_SIGNING_KEY || '').trim();
if (!pem) fail('RELEASE_SIGNING_KEY is not set (secret of the GitHub `release` environment).');
let privateKey;
try {
  privateKey = crypto.createPrivateKey(pem);
} catch (err) {
  fail(`RELEASE_SIGNING_KEY is not a valid private key: ${err.message}`);
}
if (privateKey.asymmetricKeyType !== 'ed25519') fail('RELEASE_SIGNING_KEY must be an Ed25519 key.');
const pub = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
if (!RELEASE_PUBLIC_KEYS.includes(pub)) {
  fail('RELEASE_SIGNING_KEY does not match any key in lib/updater/keys.mjs — the app would refuse this release.');
}

if (process.argv[2] === '--check') {
  console.log('✓ release-signing key matches lib/updater/keys.mjs');
  process.exit(0);
}

const [dir, rawVersion] = process.argv.slice(2);
const version = normalizeVersion(rawVersion);
if (!dir || !version) fail('usage: node scripts/sign-release.mjs <dir> <version>');
const sumsFile = path.join(dir, CHECKSUMS_ASSET);
if (!fs.existsSync(sumsFile)) fail(`${sumsFile} not found`);
const text = fs.readFileSync(sumsFile, 'utf8');
const signature = crypto.sign(null, signedMessage(version, text), privateKey).toString('base64');
if (!verifyChecksumsSignature({ version, checksumsText: text, signature, keys: RELEASE_PUBLIC_KEYS })) {
  fail('the new signature does not verify with lib/updater/keys.mjs');
}
fs.writeFileSync(path.join(dir, SIGNATURE_ASSET), `${signature}\n`);
console.log(`✓ signed ${CHECKSUMS_ASSET} for v${version} → ${SIGNATURE_ASSET}`);
