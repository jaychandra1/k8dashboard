// "What's new": the features added in each version of K8Board, shipped with
// the app in release-notes.json (at the app root, next to VERSION). Help →
// Show Release Notes reads it from there: nothing is fetched, so it works
// offline and shows only what was written for the people who use K8Board.
//
//   { "releases": [
//       { "version": "next", "highlights": [{ "title": "…", "text": "…" }] },
//       { "version": "1.8.7", "date": "2026-11-11", "highlights": [ … ] } ] }
//
// "next" holds what is being added now. It belongs to the build it ships in,
// so it is shown under the running version; `npm run version:sync <version>`
// gives it that number and the day's date (stampNextRelease).
import fs from 'node:fs';
import path from 'node:path';
import { compareVersions, normalizeVersion } from './updater/version.mjs';

export const RELEASE_NOTES_FILE = 'release-notes.json';
export const NEXT = 'next';
const MAX_RELEASES = 40;
const MAX_HIGHLIGHTS = 12;
const MAX_TITLE = 90;
const MAX_TEXT = 500;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const line = (value, max) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';

function highlightsOf(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const title = line(item?.title, MAX_TITLE);
    if (title) out.push({ title, text: line(item?.text, MAX_TEXT) });
    if (out.length === MAX_HIGHLIGHTS) break;
  }
  return out;
}

/**
 * The file's entries that are well formed, in file order: each
 * { version: "1.8.7" | "next", date: "YYYY-MM-DD" | null, highlights }.
 * One entry per version (the first wins); entries with nothing to say are left out.
 */
export function parseReleaseNotes(data) {
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(data?.releases) ? data.releases : []) {
    const version = entry?.version === NEXT ? NEXT : normalizeVersion(entry?.version);
    const highlights = highlightsOf(entry?.highlights);
    if (!version || seen.has(version) || !highlights.length) continue;
    seen.add(version);
    out.push({
      version,
      date: typeof entry.date === 'string' && DATE.test(entry.date) ? entry.date : null,
      highlights,
    });
  }
  return out;
}

/**
 * What Help → Show Release Notes shows for the running version:
 * { current, releases: [{ version, date, current, highlights }] }, newest first.
 * Versions newer than the running one are left out (their features aren't in
 * this copy), and "next" counts as the running version.
 */
export function releaseNotesFor(data, currentVersion) {
  const current = normalizeVersion(String(currentVersion ?? ''));
  const entries = parseReleaseNotes(data);
  const next = entries.find((e) => e.version === NEXT);
  let releases = entries.filter((e) => e.version !== NEXT);
  if (current) {
    releases = releases.filter((e) => compareVersions(e.version, current) <= 0);
    if (next) {
      const mine = releases.find((e) => e.version === current);
      if (mine) mine.highlights = [...next.highlights, ...mine.highlights].slice(0, MAX_HIGHLIGHTS);
      else releases.push({ version: current, date: null, highlights: next.highlights });
    }
  }
  releases.sort((a, b) => compareVersions(b.version, a.version));
  return {
    current: current || null,
    releases: releases.slice(0, MAX_RELEASES).map((e) => ({ ...e, current: e.version === current })),
  };
}

/** The shipped notes for `currentVersion`; no notes (never an error) when the file is missing or unreadable. */
export function readReleaseNotes({ rootDir, currentVersion, log, readFile = fs.readFileSync } = {}) {
  let data = null;
  try {
    data = JSON.parse(readFile(path.join(rootDir, RELEASE_NOTES_FILE), 'utf8'));
  } catch (err) {
    log?.warn?.('release notes could not be read', { detail: err?.code || err?.message });
  }
  return releaseNotesFor(data, currentVersion);
}

/**
 * Give the "next" entry its version number and date (a release is being cut).
 * Returns { data, stamped }: `data` is a new object, `stamped` is false when
 * there is no "next" entry or `version` already has one.
 */
export function stampNextRelease(data, version, date) {
  const v = normalizeVersion(String(version ?? ''));
  const releases = Array.isArray(data?.releases) ? data.releases : null;
  if (!v || !releases || !DATE.test(String(date))) return { data, stamped: false };
  const at = releases.findIndex((e) => e?.version === NEXT);
  if (at < 0 || releases.some((e) => normalizeVersion(e?.version) === v)) return { data, stamped: false };
  const { highlights, ...rest } = releases[at];
  const stamped = { ...rest, version: v, date: String(date), highlights };
  return { data: { ...data, releases: releases.map((e, i) => (i === at ? stamped : e)) }, stamped: true };
}
