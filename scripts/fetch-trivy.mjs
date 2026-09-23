#!/usr/bin/env node
// Download the `trivy` binary into ./bin so the packaged app can ship it — the
// Security Center's built-in image scan then needs no in-cluster operator and no
// runtime download. Run automatically before electron-builder (see package.json).
//
//   node scripts/fetch-trivy.mjs           # current OS/arch → bin/trivy
//   node scripts/fetch-trivy.mjs --all     # every platform  → bin/<os>-<arch>/trivy
//
// Supply-chain rules (fail closed):
//   * The version is PINNED (TRIVY_VERSION below — keep it equal to the
//     `ARG TRIVY_VERSION` in the Dockerfile). There is no "latest" lookup.
//   * Every archive is verified against the release's `trivy_<ver>_checksums.txt`
//     before it is extracted. A missing or mismatching checksum aborts.
//   * An existing binary is only reused when `bin/<…>/trivy.version` records
//     the same pinned version; anything else is re-downloaded and re-verified.
//
// bin/ is gitignored — the binaries are fetched per build, not committed.
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

export const TRIVY_VERSION = '0.74.0';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin');
const RELEASE_BASE = `https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}`;
const VERSION_MARKER = 'trivy.version';

// GitHub release asset naming (see github.com/aquasecurity/trivy/releases).
const TARGETS = {
  'darwin-arm64': { asset: 'macOS-ARM64', ext: 'tar.gz', out: 'trivy' },
  'darwin-x64': { asset: 'macOS-64bit', ext: 'tar.gz', out: 'trivy' },
  'linux-x64': { asset: 'Linux-64bit', ext: 'tar.gz', out: 'trivy' },
  'linux-arm64': { asset: 'Linux-ARM64', ext: 'tar.gz', out: 'trivy' },
  'win32-x64': { asset: 'windows-64bit', ext: 'zip', out: 'trivy.exe' },
};

async function download(url) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'kubepilot-fetch-trivy' } });
  if (!r.ok) throw new Error(`download failed: ${url} (HTTP ${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

let checksumsCache = null;
async function checksums() {
  if (checksumsCache) return checksumsCache;
  const text = (await download(`${RELEASE_BASE}/trivy_${TRIVY_VERSION}_checksums.txt`)).toString('utf8');
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(\S+)$/i);
    if (m) map.set(m[2], m[1].toLowerCase());
  }
  if (map.size === 0) throw new Error('checksums file is empty or unparsable');
  checksumsCache = map;
  return map;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function recordedVersion(dir) {
  try {
    return fs.readFileSync(path.join(dir, VERSION_MARKER), 'utf8').trim();
  } catch {
    return null;
  }
}

export async function fetchOne(key, dir) {
  const t = TARGETS[key];
  if (!t) {
    console.log(`skip ${key} (unsupported platform for a bundled trivy)`);
    return false;
  }
  const outPath = path.join(dir, t.out);
  if (fs.existsSync(outPath) && recordedVersion(dir) === TRIVY_VERSION) {
    console.log(`✓ ${key}: trivy ${TRIVY_VERSION} already present`);
    return true;
  }
  fs.mkdirSync(dir, { recursive: true });
  // Stale or unknown binary: never trust it — remove and re-fetch.
  for (const f of [outPath, path.join(dir, VERSION_MARKER)]) fs.rmSync(f, { force: true });

  const asset = `trivy_${TRIVY_VERSION}_${t.asset}.${t.ext}`;
  const url = `${RELEASE_BASE}/${asset}`;
  const expected = (await checksums()).get(asset);
  if (!expected) throw new Error(`no checksum published for ${asset} — refusing to install`);

  console.log(`↓ ${key}: ${url}`);
  const data = await download(url);
  const actual = sha256(data);
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${asset}\n  expected ${expected}\n  actual   ${actual}`);
  }
  console.log(`  sha256 ok (${expected.slice(0, 12)}…)`);

  const archive = path.join(dir, asset);
  fs.writeFileSync(archive, data);
  try {
    // bsdtar/libarchive (present on macOS/Linux/Win10+) extracts both .tar.gz and .zip.
    execFileSync(
      'tar',
      t.ext === 'zip' ? ['-xf', archive, '-C', dir, t.out] : ['-xzf', archive, '-C', dir, 'trivy'],
      {
        stdio: 'inherit',
      }
    );
  } finally {
    fs.rmSync(archive, { force: true });
  }
  if (!fs.existsSync(outPath)) throw new Error(`extraction produced no ${t.out}`);
  if (process.platform !== 'win32') fs.chmodSync(outPath, 0o755);
  fs.writeFileSync(path.join(dir, VERSION_MARKER), `${TRIVY_VERSION}\n`);
  console.log(`✓ ${key} → ${path.relative(ROOT, outPath)}`);
  return true;
}

async function main() {
  const all = process.argv.includes('--all');
  console.log(`trivy v${TRIVY_VERSION} (pinned)`);
  if (all) {
    for (const key of Object.keys(TARGETS)) await fetchOne(key, path.join(BIN, key));
  } else {
    const key = `${process.platform}-${process.arch}`;
    await fetchOne(key, BIN); // current platform → bin/trivy
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`fetch-trivy: ${e.message}`);
    process.exit(1);
  });
}
