// Release-signing public keys trusted by the updater.
//
// .github/workflows/release.yml signs every release's SHA256SUMS.txt with the
// Ed25519 private key held in the `release` environment (RELEASE_SIGNING_KEY)
// and uploads SHA256SUMS.txt.sig. With at least one key listed here, the
// updater installs nothing whose checksum list doesn't carry a valid signature
// from one of them — publishing a release (or a matching checksum) is no
// longer enough to ship an update.
//
// Each entry is the base64 SPKI (DER) encoding of an Ed25519 public key, as
// printed by `node scripts/release-signing-keygen.mjs`. To rotate: add the new
// key, ship a release signed with the OLD key, then sign with the new key and
// remove the old one a release later.
export const RELEASE_PUBLIC_KEYS = [
  'MCowBQYDK2VwAyEATXUuaaBa2dOAnfepfh/NqD3cPsiAYaDu8BOL3wpM43Y=',
];

/**
 * The keys this process trusts. KUBEPILOT_UPDATE_TRUSTED_KEYS (comma-separated,
 * same encoding) replaces the built-in list for tests and scratch releases; the
 * desktop app removes it from the backend's environment in installed builds
 * (electron/main.cjs), so only a development run can change the trust anchor.
 */
export function trustedReleaseKeys(env = process.env) {
  const override = String(env.KUBEPILOT_UPDATE_TRUSTED_KEYS || '').trim();
  if (override) return override.split(',').map((k) => k.trim()).filter(Boolean);
  return RELEASE_PUBLIC_KEYS;
}
