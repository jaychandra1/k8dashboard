#!/usr/bin/env node
// Single source of truth for the app version.
//
//   Bump + propagate:   node scripts/sync-version.mjs 1.2.3
//   Just propagate:     node scripts/sync-version.mjs        (reads ./VERSION)
//
// Writes the version from ./VERSION into every file that needs it:
//   * package.json / client/package.json (+ the lockfiles' own version field)
//   * Dockerfile `ARG APP_VERSION=…` (the OCI version label default)
//   * website/docs.html version badge, when the page carries one
//     (`data-app-version="…"` or `<span class="version-badge">v…</span>`)
// The UI reads it from client/package.json (via Vite) and the server exposes
// it at /api/version, so this one file drives the version everywhere.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const versionFile = path.join(repo, 'VERSION');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// Optional arg sets a new version first.
const arg = process.argv[2];
if (arg) {
  const v = arg.replace(/^v/, '').trim();
  if (!SEMVER.test(v)) {
    console.error(`✗ "${arg}" is not a valid semver (expected e.g. 1.2.3)`);
    process.exit(1);
  }
  writeFileSync(versionFile, v + '\n');
  console.log(`VERSION → ${v}`);
}

const version = readFileSync(versionFile, 'utf8').trim();
if (!SEMVER.test(version)) {
  console.error(`✗ VERSION must contain a semver like 1.2.3 (got "${version}")`);
  process.exit(1);
}

let changed = 0;

// --- package.json files ----------------------------------------------------
for (const rel of ['package.json', 'client/package.json']) {
  const file = path.join(repo, rel);
  const json = JSON.parse(readFileSync(file, 'utf8'));
  if (json.version !== version) {
    json.version = version;
    writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
    console.log(`✓ ${rel} → ${version}`);
    changed++;
  }
}

// Keep the lockfiles' own version field in sync too (both the top-level and the
// root package entry, packages['']). Only that field is touched — the resolved
// dependency tree is left exactly as-is, so this never changes installs.
for (const rel of ['package-lock.json', 'client/package-lock.json']) {
  const file = path.join(repo, rel);
  if (!existsSync(file)) continue;
  const lock = JSON.parse(readFileSync(file, 'utf8'));
  let touched = false;
  if (lock.version !== version) {
    lock.version = version;
    touched = true;
  }
  if (lock.packages?.[''] && lock.packages[''].version !== version) {
    lock.packages[''].version = version;
    touched = true;
  }
  if (touched) {
    writeFileSync(file, JSON.stringify(lock, null, 2) + '\n');
    console.log(`✓ ${rel} → ${version}`);
    changed++;
  }
}

// --- text files with an embedded version ----------------------------------
// Each entry: file, regex with a capture group around the version, and a
// human label. A file that has no match is left alone (the badge is optional).
const textTargets = [
  { rel: 'Dockerfile', re: /^(ARG APP_VERSION=")[^"\n]*(")\s*$/m, label: 'ARG APP_VERSION' },
  { rel: 'website/docs.html', re: /(data-app-version=")[^"]*(")/, label: 'data-app-version' },
  { rel: 'website/docs.html', re: /(<span class="version-badge">)v?[^<]*(<\/span>)/, label: 'version badge' },
];
for (const { rel, re, label } of textTargets) {
  const file = path.join(repo, rel);
  if (!existsSync(file)) continue;
  const src = readFileSync(file, 'utf8');
  const m = src.match(re);
  if (!m) continue;
  const prefix = label === 'version badge' ? 'v' : '';
  const next = src.replace(re, `$1${prefix}${version}$2`);
  if (next !== src) {
    writeFileSync(file, next);
    console.log(`✓ ${rel} (${label}) → ${version}`);
    changed++;
  }
}

console.log(changed ? `Synced ${changed} file(s) to ${version}.` : `Already at ${version}.`);
