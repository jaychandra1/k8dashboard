// Release signing: the checksum list published with a release, and its signature.
//
// A checksum published next to an installer only proves the download wasn't
// corrupted: whoever can publish a release can publish a matching checksum.
// Authenticity comes from SHA256SUMS.txt.sig — an Ed25519 signature, made with
// the release key in .github/workflows/release.yml (scripts/sign-release.mjs), over
//
//   "KubePilot release <version>\n" + <SHA256SUMS.txt bytes>
//
// so a signed list can't be re-attached to a different version. "KubePilot" is
// the app's name before K8Board; it stays in the signed text so signatures made
// before and after the rename are checked the same way.
//
// The app itself installs no updates and reads no release (the Microsoft Store
// delivers them), so nothing here runs in the app: this is what the release
// workflow signs with and checks its own signature against.
import crypto from 'node:crypto';

export const CHECKSUMS_ASSET = 'SHA256SUMS.txt';
export const SIGNATURE_ASSET = `${CHECKSUMS_ASSET}.sig`;

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
 * checksum list with one of the Ed25519 `keys` (base64 SPKI)?
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
