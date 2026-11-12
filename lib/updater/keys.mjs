// Release-signing public keys.
//
// .github/workflows/release.yml signs every release's SHA256SUMS.txt with the
// Ed25519 private key held in the `release` environment (RELEASE_SIGNING_KEY)
// and uploads SHA256SUMS.txt.sig. The workflow refuses to build a release
// until a key is listed here, and to publish one whose signing key isn't
// (scripts/sign-release.mjs), so a published checksum list can always be
// checked against a key in this file.
//
// The app doesn't read this: it installs no updates itself (the Microsoft
// Store delivers them).
//
// Each entry is the base64 SPKI (DER) encoding of an Ed25519 public key, as
// printed by `node scripts/release-signing-keygen.mjs`. To rotate: add the new
// key, sign one release with the OLD key, then sign with the new key and
// remove the old one a release later.

export const RELEASE_PUBLIC_KEYS = [
  'MCowBQYDK2VwAyEATXUuaaBa2dOAnfepfh/NqD3cPsiAYaDu8BOL3wpM43Y=',
];
