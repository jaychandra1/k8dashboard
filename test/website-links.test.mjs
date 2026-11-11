// The website (k8board.vercel.app) shows no GitHub addresses, and every download
// goes to the Microsoft Store through get.html — the one place the Store link
// lives. website/README.md says the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../lib/paths.mjs';

const SITE = path.join(ROOT_DIR, 'website');
// README.md too: a static host may serve it alongside the pages.
const pages = fs.readdirSync(SITE).filter((f) => /\.(html|md)$/.test(f));
const read = (f) => fs.readFileSync(path.join(SITE, f), 'utf8');

test('the site has the pages this test expects', () => {
  for (const f of ['index.html', 'get.html', 'docs.html', 'privacy.html', 'terms.html']) assert.ok(pages.includes(f), f);
});

test('no page links to or names a GitHub address', () => {
  for (const f of pages) {
    const hits = read(f).match(/[\w.-]*(?:github\.com|github\.io|githubusercontent\.com)[^\s"'<)]*/gi) || [];
    assert.deepEqual(hits, [], `${f} shows a GitHub address`);
  }
});

test('nothing on the site downloads an installer directly', () => {
  for (const f of pages) {
    const hits = read(f).match(/href="[^"]*\.(?:dmg|exe|msi|msix|appimage|deb|rpm|zip)(?:[?#][^"]*)?"/gi) || [];
    assert.deepEqual(hits, [], `${f} links to an installer`);
  }
});

test('the Microsoft Store link lives only in get.html, and its two copies agree', () => {
  const STORE = /https:\/\/apps\.microsoft\.com\/[^\s"'<]+/g;
  for (const f of pages.filter((p) => p !== 'get.html' && p !== 'README.md')) {
    assert.deepEqual(read(f).match(STORE) || [], [], `${f} should link to get.html, not the Store directly`);
  }
  const links = read('get.html').match(STORE) || [];
  assert.equal(links.length, 2, 'the redirect and the visible link');
  assert.equal(links[0], links[1], 'the redirect and the visible link point at the same Store page');
  assert.match(links[0], /^https:\/\/apps\.microsoft\.com\/detail\/[\w-]+$/);
});

test('every download button on the home page goes to get.html', () => {
  const html = read('index.html');
  const buttons = [...html.matchAll(/<a [^>]*data-os="[^"]*"[^>]*>/g)].map((m) => m[0]);
  assert.ok(buttons.length >= 1, 'at least the Windows button');
  for (const b of buttons) assert.match(b, /href="get\.html"/, b);
  assert.match(html, /id="dlNow" href="get\.html"/, "the modal's open-now link");
  assert.equal((html.match(/class="btn btn-soon"/g) || []).length, 2, 'macOS and Linux say coming soon');
});
