// Update integrity checks.
//
// A checksum published next to the installer only proves the download wasn't
// corrupted: whoever can publish a release can publish a matching checksum.
// Authenticity comes from SHA256SUMS.txt.sig — an Ed25519 signature, made with
// the release key in .github/workflows/release.yml, over
//
//   "KubePilot release <version>\n" + <SHA256SUMS.txt bytes>
//
// so a signed list can't be re-attached to a different (e.g. newer-looking)
// version to force a downgrade. When the app trusts at least one release key
// (lib/updater/keys.mjs) the signature is mandatory, the installer's SHA-256
// must come from the signed list, and GitHub's own asset `digest` is only a
// cross-check. Without a trusted key (local development builds) the two
// published checksums are used as before: both must agree when both exist, at
// least one must exist, and the downloaded bytes must match.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { updateError } from './errors.mjs';

export const CHECKSUMS_ASSET = 'SHA256SUMS.txt';
export const SIGNATURE_ASSET = `${CHECKSUMS_ASSET}.sig`;
const HEX64 = /^[0-9a-f]{64}$/;

/** The exact bytes the release key signs for `version`'s checksum list. */
export function signedMessage(version, checksumsText) {
  return Buffer.from(`KubePilot release ${version}\n${checksumsText}`, 'utf8');
}

const publicKeyCache = new Map();
function publicKey(b64) {
  if (!publicKeyCache.has(b64)) {
    let key = null;
    try {
      key = crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
      if (key.asymmetricKeyType !== 'ed25519') key = null;
    } catch {
      key = null;
    }
    publicKeyCache.set(b64, key);
  }
  return publicKeyCache.get(b64);
}

/**
 * Does `signature` (base64, as in SHA256SUMS.txt.sig) sign `version`'s
 * checksum list with one of the trusted Ed25519 `keys` (base64 SPKI)?
 */
export function verifyChecksumsSignature({ version, checksumsText, signature, keys }) {
  const sig = Buffer.from(String(signature || '').trim(), 'base64');
  if (sig.length !== 64 || !version || typeof checksumsText !== 'string') return false;
  const message = signedMessage(version, checksumsText);
  return (keys || []).some((k) => {
    const key = publicKey(k);
    try {
      return !!key && crypto.verify(null, message, key, sig);
    } catch {
      return false;
    }
  });
}

/** Parse `sha256sum` output ("<hex>  <name>" or "<hex> *<name>") → Map(name → hex). */
export function parseChecksums(text) {
  const out = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m) out.set(m[2].trim(), m[1].toLowerCase());
  }
  return out;
}

/**
 * The SHA-256 the asset must have: { sha256, sources: ['github-digest', 'SHA256SUMS.txt'] }.
 * Throws verification_unavailable when the release publishes no checksum for
 * it, and verification_failed when the two published checksums disagree.
 * With `signed`, `checksums` is the verified, signed list and must contain the
 * asset — the GitHub digest alone is never enough.
 */
export function expectedSha256(asset, checksums, { signed = false } = {}) {
  const fromApi = asset?.digest && HEX64.test(asset.digest) ? asset.digest : null;
  const fromFile = checksums instanceof Map ? checksums.get(asset?.name) || null : null;
  if (fromApi && fromFile && fromApi !== fromFile) {
    throw updateError('verification_failed', undefined, {
      detail: `published checksums disagree for ${asset.name}`,
    });
  }
  if (signed) {
    if (!fromFile) {
      throw updateError('verification_unavailable', `The update ${asset?.name || ''} isn't in the release's signed checksum list, so it will not be installed.`.replace('  ', ' '), {
        detail: 'asset missing from signed SHA256SUMS.txt',
      });
    }
    return { sha256: fromFile, sources: ['signed SHA256SUMS.txt', fromApi && 'github-digest'].filter(Boolean) };
  }
  const sha256 = fromApi || fromFile;
  if (!sha256) {
    throw updateError(
      'verification_unavailable',
      `The update ${asset?.name || ''} can't be verified because the release publishes no checksum for it, so it will not be installed.`.replace(
        '  ',
        ' '
      ),
      { detail: 'no digest and no SHA256SUMS.txt entry' }
    );
  }
  return { sha256, sources: [fromApi && 'github-digest', fromFile && CHECKSUMS_ASSET].filter(Boolean) };
}

/** Constant-time comparison of two hex digests. */
export function digestsMatch(a, b) {
  if (
    typeof a !== 'string' ||
    typeof b !== 'string' ||
    !HEX64.test(a.toLowerCase()) ||
    !HEX64.test(b.toLowerCase())
  )
    return false;
  return crypto.timingSafeEqual(Buffer.from(a.toLowerCase(), 'hex'), Buffer.from(b.toLowerCase(), 'hex'));
}

/** SHA-256 (hex) of a file, streamed. */
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve(hash.digest('hex')));
  });
}
