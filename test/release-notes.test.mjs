// Help → Show Release Notes: what's new in each version, shipped with the app
// (release-notes.json, read by lib/release-notes.mjs). Nothing is fetched, and
// nothing in the app names the people or accounts behind it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  NEXT,
  RELEASE_NOTES_FILE,
  parseReleaseNotes,
  readReleaseNotes,
  releaseNotesFor,
  stampNextRelease,
} from '../lib/release-notes.mjs';
import { MESSAGES } from '../lib/updater/errors.mjs';
import { compareVersions } from '../lib/updater/version.mjs';
import { ROOT_DIR } from '../lib/paths.mjs';

const h = (title, text = '') => ({ title, text });
const rel = (version, highlights, date) => ({ version, ...(date ? { date } : {}), highlights });
const versions = (notes) => notes.releases.map((r) => r.version);

describe('the notes for a running version', () => {
  const data = {
    releases: [
      rel(NEXT, [h('Brand new', 'Just added.')]),
      rel('1.8.7', [h('A turning wheel', 'While connecting.')], '2026-11-11'),
      rel('1.10.0', [h('From the future')], '2027-01-01'),
      rel('1.8.6', [h('Google GKE clusters', 'From Preferences.')], '2026-11-11'),
    ],
  };

  test('newest first, the running version marked, later versions left out', () => {
    const notes = releaseNotesFor(data, '1.8.7');
    assert.equal(notes.current, '1.8.7');
    assert.deepEqual(versions(notes), ['1.8.7', '1.8.6']);
    assert.deepEqual(notes.releases.map((r) => r.current), [true, false]);
    assert.equal(notes.releases[1].date, '2026-11-11');
  });

  test('"next" is the running version: added to its entry, or its own entry when it has none', () => {
    const merged = releaseNotesFor(data, '1.8.7').releases[0];
    assert.deepEqual(merged.highlights.map((x) => x.title), ['Brand new', 'A turning wheel']);
    assert.equal(merged.date, '2026-11-11');

    const fresh = releaseNotesFor(data, 'v1.8.8');
    assert.deepEqual(versions(fresh), ['1.8.8', '1.8.7', '1.8.6']);
    assert.deepEqual(fresh.releases[0], { version: '1.8.8', date: null, current: true, highlights: [h('Brand new', 'Just added.')] });
    assert.deepEqual(fresh.releases[1].highlights.map((x) => x.title), ['A turning wheel'], 'earlier versions keep their own notes');
  });

  test('a version with no notes of its own gets none invented', () => {
    const notes = releaseNotesFor({ releases: [rel('1.8.6', [h('Google GKE clusters')])] }, '1.8.9');
    assert.deepEqual([notes.current, versions(notes), notes.releases[0].current], ['1.8.9', ['1.8.6'], false]);
  });

  test('entries that are not well formed are left out; text is plain, single-line and capped', () => {
    const notes = releaseNotesFor(
      {
        releases: [
          rel('1.2.0', [h('  Spaced\n  out  ', 'a\tb\n c'), { title: '' }, { text: 'no title' }, 'junk', null, h('x'.repeat(500), 'y'.repeat(5000))], 'not-a-date'),
          rel('1.2.0', [h('Twice')]),
          rel('latest', [h('Not a version')]),
          rel('1.1.0', []),
          rel('1.0.0', 'nope'),
          null,
          'junk',
          { version: 7, highlights: [h('Number')] },
        ],
      },
      '1.2.0'
    );
    assert.deepEqual(versions(notes), ['1.2.0']);
    const [first, long] = notes.releases[0].highlights;
    assert.deepEqual(first, h('Spaced out', 'a b c'));
    assert.deepEqual([long.title.length, long.text.length], [90, 500]);
    assert.equal(notes.releases[0].date, null);
    assert.equal(notes.releases[0].highlights.length, 2);
  });

  test('nothing to read, or a version that is not one: no notes rather than an error', () => {
    for (const bad of [null, undefined, {}, { releases: 'x' }, [], 'text']) assert.deepEqual(releaseNotesFor(bad, '1.0.0'), { current: '1.0.0', releases: [] });
    const unknown = releaseNotesFor(data, 'unknown');
    assert.equal(unknown.current, null);
    assert.deepEqual(versions(unknown), ['1.10.0', '1.8.7', '1.8.6'], '"next" belongs to no version here');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-notes-'));
    assert.deepEqual(readReleaseNotes({ rootDir: dir, currentVersion: '1.0.0' }), { current: '1.0.0', releases: [] });
    fs.writeFileSync(path.join(dir, RELEASE_NOTES_FILE), '{ not json');
    assert.deepEqual(readReleaseNotes({ rootDir: dir, currentVersion: '1.0.0' }), { current: '1.0.0', releases: [] });
  });
});

describe('cutting a release', () => {
  test('"next" takes the version and the date; everything else stays', () => {
    const data = { releases: [rel(NEXT, [h('Brand new')]), rel('1.8.7', [h('Old')], '2026-11-11')] };
    const { data: out, stamped } = stampNextRelease(data, 'v1.8.8', '2026-11-12');
    assert.equal(stamped, true);
    assert.deepEqual(out.releases[0], { version: '1.8.8', date: '2026-11-12', highlights: [h('Brand new')] });
    assert.deepEqual(out.releases[1], data.releases[1]);
    assert.equal(data.releases[0].version, NEXT, 'the input is not changed');
    assert.deepEqual(versions(releaseNotesFor(out, '1.8.8')), ['1.8.8', '1.8.7']);
  });

  test('nothing to stamp: no "next", a version that already has notes, or a bad version or date', () => {
    const noNext = { releases: [rel('1.8.7', [h('Old')])] };
    assert.equal(stampNextRelease(noNext, '1.8.8', '2026-11-12').stamped, false);
    const taken = { releases: [rel(NEXT, [h('New')]), rel('1.8.8', [h('Already')])] };
    assert.deepEqual(stampNextRelease(taken, '1.8.8', '2026-11-12'), { data: taken, stamped: false });
    const ok = { releases: [rel(NEXT, [h('New')])] };
    assert.equal(stampNextRelease(ok, 'soon', '2026-11-12').stamped, false);
    assert.equal(stampNextRelease(ok, '1.8.8', '12/11/2026').stamped, false);
    assert.equal(stampNextRelease(null, '1.8.8', '2026-11-12').stamped, false);
  });

  test('npm run version:sync <version> names the "next" notes, once', () => {
    // A copy of what the script touches, so the repository itself is left alone.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-sync-'));
    for (const d of ['scripts', 'lib/updater', 'client']) fs.mkdirSync(path.join(dir, d), { recursive: true });
    for (const f of ['scripts/sync-version.mjs', 'lib/release-notes.mjs', 'lib/updater/version.mjs'])
      fs.copyFileSync(path.join(ROOT_DIR, f), path.join(dir, f));
    fs.writeFileSync(path.join(dir, 'VERSION'), '1.0.0\n');
    for (const f of ['package.json', 'client/package.json']) fs.writeFileSync(path.join(dir, f), JSON.stringify({ name: 'x', version: '1.0.0', type: 'module' }, null, 2) + '\n');
    const file = path.join(dir, RELEASE_NOTES_FILE);
    fs.writeFileSync(file, JSON.stringify({ releases: [rel(NEXT, [h('Brand new', 'Arrows → and “quotes” survive.')]), rel('1.0.0', [h('First')], '2026-01-01')] }, null, 2) + '\n');
    const sync = (...args) => execFileSync(process.execPath, [path.join(dir, 'scripts', 'sync-version.mjs'), ...args], { encoding: 'utf8' });

    assert.doesNotMatch(sync(), /release-notes/, 'propagating the version alone leaves the notes');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).releases[0].version, NEXT);

    const out = sync('1.1.0');
    assert.match(out, /release-notes\.json: "next" → 1\.1\.0/);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.releases[0].version, '1.1.0');
    assert.match(after.releases[0].date, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(after.releases[0].highlights, [h('Brand new', 'Arrows → and “quotes” survive.')]);
    assert.deepEqual(after.releases[1], rel('1.0.0', [h('First')], '2026-01-01'));
    assert.equal(fs.readFileSync(path.join(dir, 'VERSION'), 'utf8'), '1.1.0\n');

    // A later bump with nothing new written says so and changes nothing.
    assert.match(sync('1.2.0'), /has no notes for 1\.2\.0/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), after);
  });
});

describe('the notes that ship', () => {
  const version = fs.readFileSync(path.join(ROOT_DIR, 'VERSION'), 'utf8').trim();
  const text = fs.readFileSync(path.join(ROOT_DIR, RELEASE_NOTES_FILE), 'utf8');
  const raw = JSON.parse(text);

  test('every entry is well formed, newest first, with "next" (if any) on top', () => {
    const parsed = parseReleaseNotes(raw);
    assert.equal(parsed.length, raw.releases.length, 'an entry is malformed or repeated');
    parsed.forEach((entry, i) => {
      assert.equal(entry.highlights.length, raw.releases[i].highlights.length, `${entry.version}: a highlight has no title`);
      if (entry.version === NEXT) return assert.equal(i, 0, '"next" comes first');
      assert.match(entry.date || '', /^\d{4}-\d{2}-\d{2}$/, `${entry.version} needs a date`);
      const before = parsed[i - 1];
      if (before && before.version !== NEXT) assert.equal(compareVersions(before.version, entry.version), 1, `${before.version} should come before ${entry.version}`);
      for (const item of entry.highlights) assert.ok(item.text.length >= 20, `${entry.version}: "${item.title}" needs a sentence`);
    });
  });

  test(`this version (${version}) has notes of its own`, () => {
    const notes = readReleaseNotes({ rootDir: ROOT_DIR, currentVersion: version });
    assert.deepEqual(
      [notes.releases[0]?.version, notes.releases[0]?.current],
      [version, true],
      `${RELEASE_NOTES_FILE} has no notes for ${version}: add a "next" entry with what is new (it is shown as this version's notes)`
    );
    assert.ok(notes.releases.length >= 2, 'earlier versions are listed too');
  });

  test('they are written for users: no addresses, accounts, repositories or commit ids', () => {
    assert.doesNotMatch(text, /https?:|www\.|github|ghcr\.io|gitlab|@[a-z]|[\w.-]+\/[\w.-]+@|\b[0-9a-f]{12,}\b|sha256|changelog/i);
  });

  test('the file is packaged with the desktop app and the container image', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    assert.ok(pkg.build.files.includes(RELEASE_NOTES_FILE));
    assert.match(fs.readFileSync(path.join(ROOT_DIR, 'Dockerfile'), 'utf8'), /^COPY package\.json package-lock\.json VERSION release-notes\.json \.\/$/m);
  });
});

describe('no developer information in the app', () => {
  // The sources that become the app: the UI, the desktop shell and the backend.
  const shipped = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!['node_modules', 'dist', 'coverage'].includes(e.name)) walk(p);
      } else if (/\.(jsx?|mjs|cjs|html|css)$/.test(e.name) && !/\.test\.[a-z]+$/.test(e.name)) shipped.push(p);
    }
  };
  for (const d of ['client/src', 'electron', 'lib']) walk(path.join(ROOT_DIR, d));
  for (const e of fs.readdirSync(ROOT_DIR)) if (/\.js$/.test(e) && e !== 'eslint.config.js') shipped.push(path.join(ROOT_DIR, e));
  for (const f of ['package.json', 'VERSION', 'release-notes.json']) shipped.push(path.join(ROOT_DIR, f));
  // The account the releases are published under: named by the release workflow, which is not part of the app.
  const workflow = fs.readFileSync(path.join(ROOT_DIR, '.github', 'workflows', 'release.yml'), 'utf8');
  const owner = (workflow.match(/^\s*RELEASE_REPO:\s*([\w.-]+)\//m) || [])[1] || '';

  test('no source names the account or repository the releases come from', () => {
    assert.ok(shipped.length > 100 && owner.length > 2);
    const needle = new RegExp(owner.replace(/[^\w-]/g, ''), 'i');
    const hits = shipped.filter((f) => needle.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT_DIR, f));
    assert.deepEqual(hits, []);
  });

  test('the update and release notes dialogs name no hosting service and link to no release page', () => {
    const ui = fs.readFileSync(path.join(ROOT_DIR, 'client', 'src', 'components', 'UpdateDialogs.jsx'), 'utf8');
    const code = ui.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.doesNotMatch(code, /github|View Release|release page|htmlUrl|https?:\/\/|Download and Install|Restart Now/i);
    for (const [code_, message] of Object.entries(MESSAGES)) assert.doesNotMatch(message, /github|release page/i, code_);
    const main = fs.readFileSync(path.join(ROOT_DIR, 'electron', 'main.cjs'), 'utf8');
    assert.match(main, /\{ label: 'Show Release Notes', click: \(\) => notifyRendererWhenReady\(\{ type: 'show-release-notes' \}\) \},/, 'on every platform');
  });
});
