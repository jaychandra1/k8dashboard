// Semantic versions for the updater: parsing, normalisation ("v1.3.0" →
// "1.3.0") and SemVer 2.0.0 precedence — never plain string comparison
// ("1.10.0" > "1.9.0"). No dependencies.

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/i;

/**
 * Parse "1.3.0", "v1.3.0", "1.4.0-rc.1", "1.4.0+build.5".
 * Returns { major, minor, patch, prerelease: [...], version } or null.
 * `version` is the normalised form without the "v" and build metadata.
 */
export function parseVersion(input) {
  if (typeof input !== 'string') return null;
  const m = input.trim().match(SEMVER);
  if (!m) return null;
  const [, major, minor, patch, pre] = m;
  const prerelease = pre ? pre.split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [];
  const core = `${major}.${minor}.${patch}`;
  return { major: Number(major), minor: Number(minor), patch: Number(patch), prerelease, version: pre ? `${core}-${pre}` : core };
}

/** "v1.3.0" → "1.3.0"; null when the input is not a version. */
export const normalizeVersion = (input) => parseVersion(input)?.version ?? null;

/** True for 1.4.0-alpha.1, 1.4.0-beta.1, 1.4.0-rc.1 and any other prerelease. */
export const isPrerelease = (input) => (parseVersion(input)?.prerelease.length ?? 0) > 0;

/** A parseable version with no prerelease part. */
export const isStableVersion = (input) => {
  const v = parseVersion(input);
  return !!v && v.prerelease.length === 0;
};

function compareIdentifiers(a, b) {
  const an = typeof a === 'number';
  const bn = typeof b === 'number';
  if (an && bn) return a === b ? 0 : a < b ? -1 : 1;
  if (an) return -1; // numeric identifiers sort before alphanumeric ones
  if (bn) return 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * SemVer precedence: -1 when a < b, 0 when equal, 1 when a > b. Build
 * metadata is ignored; a prerelease sorts before its release. Throws a
 * TypeError for anything that is not a version.
 */
export function compareVersions(a, b) {
  const va = typeof a === 'string' ? parseVersion(a) : a;
  const vb = typeof b === 'string' ? parseVersion(b) : b;
  if (!va || !vb) throw new TypeError(`Not a semantic version: ${!va ? a : b}`);
  for (const k of ['major', 'minor', 'patch']) {
    if (va[k] !== vb[k]) return va[k] < vb[k] ? -1 : 1;
  }
  const pa = va.prerelease;
  const pb = vb.prerelease;
  if (!pa.length || !pb.length) return pa.length === pb.length ? 0 : pa.length ? -1 : 1;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const c = compareIdentifiers(pa[i], pb[i]);
    if (c) return c;
  }
  return 0;
}

/** Is `latest` newer than `current`? */
export const isNewerVersion = (latest, current) => compareVersions(latest, current) > 0;
