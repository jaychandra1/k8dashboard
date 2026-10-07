// Help → Show Release Notes / Check for Updates: version comparison, the
// GitHub release service, asset selection, download + verification, the
// update workflow and the installers' command plans. All network access and
// every installer is mocked — nothing here contacts GitHub or installs anything.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  compareVersions,
  isNewerVersion,
  isPrerelease,
  normalizeVersion,
  parseVersion,
} from '../lib/updater/version.mjs';
import { createReleaseService, normalizeRelease, releaseRepository } from '../lib/updater/github.mjs';
import { detectTarget, parseAssetName, selectAsset } from '../lib/updater/platform.mjs';
import { downloadFile, isAllowedDownloadUrl } from '../lib/updater/download.mjs';
import { digestsMatch, expectedSha256, parseChecksums } from '../lib/updater/verify.mjs';
import { createUpdateService } from '../lib/updater/service.mjs';
import { createHostBridge } from '../lib/updater/host.mjs';
import {
  detectInstall,
  installAppImage,
  installDeb,
  installDmg,
  launchNsisInstaller,
  macBundlePath,
  macSwapScript,
  nsisArgs,
} from '../lib/updater/install.mjs';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kp-updater-'));
const json = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

// A fake GitHub: routes keyed by URL → Response factory.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const h = routes[String(url)];
    if (!h) return new Response('not found', { status: 404 });
    return typeof h === 'function' ? h(opts) : h.clone();
  };
  fn.calls = calls;
  return fn;
}

const REPO = 'jaychandra1/KubePilot';
const API = `https://api.github.com/repos/${REPO}`;
const DL = `https://github.com/${REPO}/releases/download`;

function ghRelease(tag, { prerelease = false, draft = false, assets = [], body = '## Notes' } = {}) {
  return {
    tag_name: tag,
    name: `KubePilot ${tag.replace(/^v/, '')}`,
    published_at: '2026-10-01T10:00:00Z',
    body,
    html_url: `https://github.com/${REPO}/releases/tag/${tag}`,
    prerelease,
    draft,
    assets: assets.map((a) => ({
      name: a.name,
      size: a.size ?? a.data?.length ?? 10,
      browser_download_url: `${DL}/${tag}/${a.name}`,
      digest: a.digest,
      content_type: 'application/octet-stream',
    })),
  };
}

describe('version comparison', () => {
  test('update decisions', () => {
    assert.equal(isNewerVersion('1.3.0', '1.3.0'), false);
    assert.equal(isNewerVersion('1.3.1', '1.3.0'), true);
    assert.equal(isNewerVersion('1.4.0', '1.3.0'), true);
    assert.equal(isNewerVersion('2.0.0', '1.3.0'), true);
    assert.equal(isNewerVersion('1.2.9', '1.3.0'), false);
    assert.equal(isNewerVersion('1.10.0', '1.9.0'), true, 'numeric, not string, comparison');
  });
  test('normalisation and prereleases', () => {
    assert.equal(normalizeVersion('v1.3.0'), '1.3.0');
    assert.equal(normalizeVersion(' V2.0.1 '), '2.0.1');
    assert.equal(normalizeVersion('1.4.0+build.7'), '1.4.0');
    assert.equal(normalizeVersion('1.3'), null);
    assert.equal(normalizeVersion('latest'), null);
    for (const v of ['1.4.0-beta.1', '1.4.0-alpha.1', '1.4.0-rc.1', 'v2.0.0-next'])
      assert.equal(isPrerelease(v), true, v);
    assert.equal(isPrerelease('1.4.0'), false);
    assert.deepEqual(parseVersion('1.4.0-rc.1').prerelease, ['rc', 1]);
  });
  test('SemVer precedence for prereleases', () => {
    const order = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];
    for (let i = 1; i < order.length; i++)
      assert.equal(compareVersions(order[i - 1], order[i]), -1, `${order[i - 1]} < ${order[i]}`);
    assert.throws(() => compareVersions('nope', '1.0.0'), TypeError);
  });
});

describe('GitHub release service', () => {
  const svc = (routes, opts) =>
    createReleaseService({ repo: REPO, fetchImpl: fakeFetch(routes), cacheMs: 0, ...opts });

  test('reads the latest stable release (tag, name, date, body, URL, assets + digests)', async () => {
    const digest = 'a'.repeat(64);
    const r = await svc({
      [`${API}/releases/latest`]: json(
        ghRelease('v1.4.0', {
          assets: [{ name: 'KubePilot-windows.exe', digest: `sha256:${digest}` }, { name: 'SHA256SUMS.txt' }],
        })
      ),
    }).latest();
    assert.equal(r.version, '1.4.0');
    assert.equal(r.tag, 'v1.4.0');
    assert.equal(r.name, 'KubePilot 1.4.0');
    assert.equal(r.publishedAt, '2026-10-01T10:00:00Z');
    assert.equal(r.body, '## Notes');
    assert.equal(r.htmlUrl, `https://github.com/${REPO}/releases/tag/v1.4.0`);
    assert.equal(r.assets[0].digest, digest);
    assert.equal(r.assets[1].digest, null);
  });

  test('ignores drafts and prereleases (flagged or only tagged as such)', async () => {
    const list = [
      ghRelease('v1.5.0-rc.1'),
      ghRelease('v1.6.0', { draft: true }),
      ghRelease('v1.5.0-beta.1', { prerelease: true }),
      ghRelease('v1.4.0'),
      ghRelease('v1.3.0'),
    ];
    const r = await svc({
      [`${API}/releases/latest`]: json(ghRelease('v1.5.0-rc.1')),
      [`${API}/releases?per_page=30`]: json(list),
    }).latest();
    assert.equal(r.version, '1.4.0');
  });

  test('no releases → no_releases; only prereleases → no_releases', async () => {
    await assert.rejects(svc({ [`${API}/releases?per_page=30`]: json([]) }).latest(), {
      code: 'no_releases',
    });
    await assert.rejects(
      svc({
        [`${API}/releases?per_page=30`]: json([ghRelease('v2.0.0-alpha.1', { prerelease: true })]),
      }).latest(),
      { code: 'no_releases' }
    );
  });

  test('malformed responses and versions', async () => {
    await assert.rejects(
      svc({ [`${API}/releases/latest`]: new Response('<html>', { status: 200 }) }).latest(),
      { code: 'invalid_response' }
    );
    await assert.rejects(svc({ [`${API}/releases/latest`]: json([1, 2]) }).latest(), {
      code: 'invalid_response',
    });
    await assert.rejects(
      svc({
        [`${API}/releases/latest`]: json(ghRelease('release-2026')),
        [`${API}/releases?per_page=30`]: json([ghRelease('release-2026')]),
      }).latest(),
      { code: 'malformed_version' }
    );
    assert.throws(() => normalizeRelease({ name: 'x' }), { code: 'invalid_response' });
  });

  test('GitHub unavailable, rate limited, offline, timeout', async () => {
    await assert.rejects(svc({ [`${API}/releases/latest`]: new Response('', { status: 503 }) }).latest(), {
      code: 'github_unavailable',
    });
    await assert.rejects(
      svc({
        [`${API}/releases/latest`]: new Response('', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1900000000' },
        }),
      }).latest(),
      (e) => e.code === 'rate_limited' && /try again after/i.test(e.message)
    );
    await assert.rejects(svc({ [`${API}/releases/latest`]: new Response('', { status: 429 }) }).latest(), {
      code: 'rate_limited',
    });
    const offline = createReleaseService({
      repo: REPO,
      fetchImpl: async () => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), { code: 'ENOTFOUND' }),
        });
      },
    });
    await assert.rejects(
      offline.latest(),
      (e) => e.code === 'offline' && /could not connect to GitHub/.test(e.message) && e.detail === 'ENOTFOUND'
    );
    const slow = createReleaseService({
      repo: REPO,
      fetchImpl: async () => {
        throw new DOMException('timed out', 'TimeoutError');
      },
    });
    await assert.rejects(slow.latest(), { code: 'timeout' });
  });

  test('sends no credentials; only https asset URLs on github.com survive', async () => {
    const f = fakeFetch({
      [`${API}/releases/latest`]: json({
        ...ghRelease('v1.4.0'),
        assets: [
          {
            name: 'KubePilot-windows.exe',
            size: 1,
            browser_download_url: 'http://github.com/x/KubePilot-windows.exe',
          },
          {
            name: 'KubePilot-linux.deb',
            size: 1,
            browser_download_url: 'https://evil.example/KubePilot-linux.deb',
          },
          { name: 'KubePilot-macos.dmg', size: 1, browser_download_url: `${DL}/v1.4.0/KubePilot-macos.dmg` },
        ],
      }),
    });
    const r = await createReleaseService({ repo: REPO, fetchImpl: f }).latest();
    assert.deepEqual(
      r.assets.map((a) => a.name),
      ['KubePilot-macos.dmg']
    );
    const headers = f.calls[0].opts.headers;
    assert.equal(
      Object.keys(headers).some((h) => /authorization/i.test(h)),
      false
    );
    assert.match(f.calls[0].url, /^https:\/\/api\.github\.com\//);
  });

  test('repository comes from package.json, overridable for test releases', () => {
    assert.equal(releaseRepository({ pkg: { releaseRepository: REPO }, env: {} }), REPO);
    assert.equal(
      releaseRepository({ pkg: { releaseRepository: REPO }, env: { KUBEPILOT_UPDATE_REPO: 'me/kp-test' } }),
      'me/kp-test'
    );
    assert.equal(
      releaseRepository({ pkg: { releaseRepository: REPO }, env: { KUBEPILOT_UPDATE_REPO: '../../etc' } }),
      REPO
    );
    assert.equal(releaseRepository({ pkg: {}, env: {} }), null);
  });
});

describe('platform / asset selection', () => {
  // The names today's release workflow publishes (unsuffixed = Windows x64, Linux x64, macOS arm64).
  const CURRENT = [
    'KubePilot-windows.exe',
    'KubePilot-macos.dmg',
    'KubePilot-linux.AppImage',
    'KubePilot-linux.deb',
    'SHA256SUMS.txt',
    'kubepilot-v1.4.0.cdx.json',
  ].map((name) => ({ name }));
  const ALL_ARCHES = [
    'windows-x64.exe',
    'windows-arm64.exe',
    'linux-x64.AppImage',
    'linux-arm64.AppImage',
    'macos-x64.dmg',
    'macos-arm64.dmg',
    'linux-x64.deb',
    'linux-arm64.deb',
  ].map((s) => ({ name: `KubePilot-1.4.0-${s}` }));
  const pick = (assets, platform, arch, installKind) =>
    selectAsset(assets, detectTarget({ platform, arch, installKind }), { version: '1.4.0' }).name;

  test('detects OS / arch', () => {
    assert.deepEqual(detectTarget({ platform: 'win32', arch: 'arm64' }), {
      os: 'windows',
      arch: 'arm64',
      installKind: 'nsis',
      label: 'Windows ARM64',
    });
    assert.equal(detectTarget({ platform: 'linux', arch: 'x64', installKind: 'deb' }).installKind, 'deb');
    assert.equal(
      detectTarget({ platform: 'linux', arch: 'x64', installKind: 'dmg' }).installKind,
      'appimage',
      'kind must fit the OS'
    );
    assert.equal(detectTarget({ platform: 'darwin', arch: 'ia32' }).arch, null);
  });

  test('parses asset names (case-insensitive, optional version / arch)', () => {
    assert.deepEqual(parseAssetName('KubePilot-windows.exe'), {
      os: 'windows',
      arch: null,
      ext: 'exe',
      version: null,
    });
    assert.deepEqual(parseAssetName('kubepilot-1.4.0-macos-arm64.dmg'), {
      os: 'macos',
      arch: 'arm64',
      ext: 'dmg',
      version: '1.4.0',
    });
    assert.deepEqual(parseAssetName('KubePilot-linux-aarch64.AppImage'), {
      os: 'linux',
      arch: 'arm64',
      ext: 'appimage',
      version: null,
    });
    for (const n of [
      'SHA256SUMS.txt',
      'KubePilot-windows.exe.blockmap',
      'Other-windows.exe',
      'KubePilot-windows-ia32.exe',
      'latest.yml',
    ])
      assert.equal(parseAssetName(n), null, n);
  });

  test('every OS / arch with explicitly named assets', () => {
    assert.equal(pick(ALL_ARCHES, 'win32', 'x64'), 'KubePilot-1.4.0-windows-x64.exe');
    assert.equal(pick(ALL_ARCHES, 'win32', 'arm64'), 'KubePilot-1.4.0-windows-arm64.exe');
    assert.equal(pick(ALL_ARCHES, 'linux', 'x64', 'appimage'), 'KubePilot-1.4.0-linux-x64.AppImage');
    assert.equal(pick(ALL_ARCHES, 'linux', 'arm64', 'appimage'), 'KubePilot-1.4.0-linux-arm64.AppImage');
    assert.equal(pick(ALL_ARCHES, 'linux', 'arm64', 'deb'), 'KubePilot-1.4.0-linux-arm64.deb');
    assert.equal(pick(ALL_ARCHES, 'darwin', 'x64'), 'KubePilot-1.4.0-macos-x64.dmg');
    assert.equal(pick(ALL_ARCHES, 'darwin', 'arm64'), 'KubePilot-1.4.0-macos-arm64.dmg');
  });

  test("today's unsuffixed names map to the one arch each OS is built for", () => {
    assert.equal(pick(CURRENT, 'win32', 'x64'), 'KubePilot-windows.exe');
    assert.equal(pick(CURRENT, 'darwin', 'arm64'), 'KubePilot-macos.dmg');
    assert.equal(pick(CURRENT, 'linux', 'x64', 'appimage'), 'KubePilot-linux.AppImage');
    assert.equal(pick(CURRENT, 'linux', 'x64', 'deb'), 'KubePilot-linux.deb');
    assert.throws(
      () => pick(CURRENT, 'win32', 'arm64'),
      (e) => e.code === 'no_asset_for_arch' && /Windows ARM64/.test(e.message)
    );
    assert.throws(
      () => pick(CURRENT, 'darwin', 'x64'),
      (e) => e.code === 'no_asset_for_arch' && /macOS x64/.test(e.message)
    );
    assert.throws(() => pick(CURRENT, 'linux', 'arm64', 'appimage'), { code: 'no_asset_for_arch' });
  });

  test('missing assets, unrelated installers and other versions are never picked', () => {
    assert.throws(() => pick([], 'win32', 'x64'), { code: 'no_asset_for_os' });
    assert.throws(
      () =>
        pick(
          [{ name: 'KubePilot-macos.dmg' }, { name: 'setup.exe' }, { name: 'Other-windows.exe' }],
          'win32',
          'x64'
        ),
      (e) => e.code === 'no_asset_for_os' && /KubePilot v1\.4\.0 is available/.test(e.message)
    );
    assert.throws(() => pick([{ name: 'KubePilot-1.3.0-windows-x64.exe' }], 'win32', 'x64'), {
      code: 'no_asset_for_os',
    });
    assert.throws(() => pick(CURRENT, 'freebsd', 'x64'), { code: 'no_asset_for_os' });
    // An explicit arch beats the unsuffixed build.
    assert.equal(
      pick([{ name: 'KubePilot-windows.exe' }, { name: 'KubePilot-windows-x64.exe' }], 'win32', 'x64'),
      'KubePilot-windows-x64.exe'
    );
  });
});

describe('verification', () => {
  const good = sha(Buffer.from('installer'));
  test('parses SHA256SUMS.txt', () => {
    const m = parseChecksums(
      `${good}  KubePilot-windows.exe\n${'b'.repeat(64)} *KubePilot-macos.dmg\r\njunk line\n`
    );
    assert.equal(m.get('KubePilot-windows.exe'), good);
    assert.equal(m.get('KubePilot-macos.dmg'), 'b'.repeat(64));
    assert.equal(m.size, 2);
  });
  test('expected digest: either source, both must agree, none → refuse', () => {
    const asset = { name: 'KubePilot-windows.exe', digest: good };
    assert.deepEqual(expectedSha256(asset, null), { sha256: good, sources: ['github-digest'] });
    assert.deepEqual(expectedSha256({ name: asset.name, digest: null }, new Map([[asset.name, good]])), {
      sha256: good,
      sources: ['SHA256SUMS.txt'],
    });
    assert.deepEqual(expectedSha256(asset, new Map([[asset.name, good]])).sources, [
      'github-digest',
      'SHA256SUMS.txt',
    ]);
    assert.throws(() => expectedSha256(asset, new Map([[asset.name, 'c'.repeat(64)]])), {
      code: 'verification_failed',
    });
    assert.throws(() => expectedSha256({ name: asset.name, digest: null }, new Map()), {
      code: 'verification_unavailable',
    });
  });
  test('digest comparison', () => {
    assert.equal(digestsMatch(good, good.toUpperCase()), true);
    assert.equal(digestsMatch(good, 'a'.repeat(64)), false);
    assert.equal(digestsMatch(good, 'nope'), false);
  });
});

describe('download', () => {
  const data = Buffer.alloc(300_000, 7);
  const url = `${DL}/v1.4.0/KubePilot-windows.exe`;
  const cdn = 'https://release-assets.githubusercontent.com/abc?sig=1';

  test('follows GitHub redirects, streams to disk, hashes, reports progress', async () => {
    const dir = tmp();
    const seen = [];
    const f = fakeFetch({
      [url]: new Response(null, { status: 302, headers: { location: cdn } }),
      [cdn]: new Response(data, { headers: { 'content-length': String(data.length) } }),
    });
    const r = await downloadFile(url, path.join(dir, 'k.exe'), {
      fetchImpl: f,
      expectedSize: data.length,
      onProgress: (p) => seen.push(p),
    });
    assert.equal(r.sha256, sha(data));
    assert.equal(fs.readFileSync(path.join(dir, 'k.exe')).length, data.length);
    assert.equal(
      f.calls.every((c) => c.opts.redirect === 'manual'),
      true
    );
    assert.deepEqual(seen.at(-1), { received: data.length, total: data.length });
    assert.equal(fs.existsSync(path.join(dir, 'k.exe.part')), false);
  });

  test('refuses http, other hosts and redirects off GitHub', async () => {
    assert.equal(isAllowedDownloadUrl('http://github.com/x'), false);
    assert.equal(isAllowedDownloadUrl('https://evil.example/x'), false);
    assert.equal(isAllowedDownloadUrl('https://user:pw@github.com/x'), false);
    assert.equal(isAllowedDownloadUrl(cdn), true);
    const dir = tmp();
    const f = fakeFetch({
      [url]: new Response(null, { status: 302, headers: { location: 'https://evil.example/payload.exe' } }),
    });
    await assert.rejects(downloadFile(url, path.join(dir, 'k.exe'), { fetchImpl: f }), {
      code: 'download_failed',
    });
    assert.equal(f.calls.length, 1, 'never contacted the other host');
  });

  test('download failure (HTTP error, short read) leaves no file', async () => {
    const dir = tmp();
    await assert.rejects(
      downloadFile(url, path.join(dir, 'k.exe'), {
        fetchImpl: fakeFetch({ [url]: new Response('', { status: 500 }) }),
      }),
      { code: 'download_failed' }
    );
    await assert.rejects(
      downloadFile(url, path.join(dir, 'k.exe'), {
        fetchImpl: fakeFetch({ [url]: new Response(data.subarray(0, 1000)) }),
        expectedSize: data.length,
      }),
      { code: 'download_failed' }
    );
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('cancel stops the download and removes the partial file', async () => {
    const dir = tmp();
    const ctrl = new AbortController();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(1000));
      },
      pull() {
        return new Promise(() => {});
      }, // then stalls until aborted
    });
    const f = async (u, opts) => {
      opts.signal.addEventListener('abort', () => body.cancel().catch(() => {}));
      return new Response(body, { headers: { 'content-length': '5000' } });
    };
    const p = downloadFile(url, path.join(dir, 'k.exe'), {
      fetchImpl: f,
      signal: ctrl.signal,
      onProgress: () => ctrl.abort(),
    });
    await assert.rejects(p, { code: 'cancelled' });
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

describe('update workflow (service)', () => {
  const installer = Buffer.from('fake installer bytes');
  const assetsFor = (
    tag,
    { digest = sha(installer), withSums = false, name = 'KubePilot-windows.exe' } = {}
  ) => {
    const list = [{ name, data: installer, digest: digest ? `sha256:${digest}` : undefined }];
    if (withSums) list.push({ name: 'SHA256SUMS.txt' });
    return list;
  };
  function setup({
    tag = 'v1.4.0',
    current = '1.3.0',
    assets,
    sums,
    kind = 'nsis',
    platform = 'win32',
    arch = 'x64',
    host,
    latest,
  } = {}) {
    const rel = ghRelease(tag, { assets: assets || assetsFor(tag) });
    const routes = { [`${API}/releases/latest`]: latest || json(rel) };
    for (const a of rel.assets)
      routes[a.browser_download_url] = () => new Response(a.name === 'SHA256SUMS.txt' ? sums : installer);
    const fetchImpl = fakeFetch(routes);
    const requests = [];
    const fakeHost = host || {
      available: true,
      request: async (type, payload) => {
        requests.push({ type, payload });
        return type === 'install' && kind !== 'nsis' ? { installed: true } : {};
      },
    };
    const dir = tmp();
    const svc = createUpdateService({
      currentVersion: current,
      releases: createReleaseService({ repo: REPO, fetchImpl, cacheMs: 0 }),
      target: detectTarget({ platform, arch, installKind: kind }),
      install: { kind },
      updateDir: dir,
      host: fakeHost,
      fetchImpl,
    });
    return { svc, requests, dir, fetchImpl };
  }
  const settle = async (svc, phases) => {
    for (let i = 0; i < 200 && phases.includes(svc.snapshot().phase); i++)
      await new Promise((r) => setTimeout(r, 10));
    return svc.snapshot();
  };

  test('already up to date: nothing is downloaded', async () => {
    const { svc, fetchImpl } = setup({ tag: 'v1.3.0' });
    const s = await svc.check();
    assert.equal(s.phase, 'up-to-date');
    assert.equal(s.currentVersion, '1.3.0');
    assert.equal(fetchImpl.calls.length, 1);
    assert.throws(() => svc.startDownload(), { code: 'invalid_state' });
  });

  test('Windows: available → download → verify → ready → install (installer runs on restart)', async () => {
    const { svc, requests, dir } = setup();
    const checked = await svc.check();
    assert.equal(checked.phase, 'available');
    assert.equal(checked.latest.version, '1.4.0');
    assert.equal(checked.installMode, 'on-restart');
    assert.equal(requests.length, 0, 'checking never installs');
    svc.startDownload();
    const ready = await settle(svc, ['downloading', 'verifying']);
    assert.equal(ready.phase, 'ready');
    assert.equal(ready.asset.name, 'KubePilot-windows.exe');
    const file = path.join(dir, 'pending', 'KubePilot-windows.exe');
    assert.equal(sha(fs.readFileSync(file)), sha(installer));
    const done = await svc.install({ when: 'now' });
    assert.equal(done.phase, 'restarting');
    assert.deepEqual(requests, [
      {
        type: 'install',
        payload: { file, sha256: sha(installer), version: '1.4.0', kind: 'nsis', when: 'now' },
      },
    ]);
  });

  test('Windows "Later": the installer is scheduled for quit', async () => {
    const { svc, requests } = setup();
    await svc.check();
    svc.startDownload();
    await settle(svc, ['downloading', 'verifying']);
    assert.equal((await svc.install({ when: 'on-quit' })).phase, 'scheduled');
    assert.equal(requests[0].payload.when, 'on-quit');
  });

  test('macOS: verified update installs in place, then restart on request', async () => {
    const { svc, requests } = setup({
      platform: 'darwin',
      arch: 'arm64',
      kind: 'dmg',
      assets: assetsFor('v1.4.0', { name: 'KubePilot-macos.dmg' }),
    });
    await svc.check();
    svc.startDownload();
    const s = await settle(svc, ['downloading', 'verifying', 'installing']);
    assert.equal(s.phase, 'installed');
    assert.equal(requests[0].payload.kind, 'dmg');
    assert.equal((await svc.restart()).phase, 'restarting');
    assert.equal(requests[1].type, 'relaunch');
  });

  test('SHA256SUMS.txt is used too, and must agree', async () => {
    const ok = setup({
      assets: assetsFor('v1.4.0', { withSums: true }),
      sums: `${sha(installer)}  KubePilot-windows.exe\n`,
    });
    await ok.svc.check();
    ok.svc.startDownload();
    assert.equal((await settle(ok.svc, ['downloading', 'verifying'])).phase, 'ready');
    const bad = setup({
      assets: assetsFor('v1.4.0', { withSums: true }),
      sums: `${'f'.repeat(64)}  KubePilot-windows.exe\n`,
    });
    await bad.svc.check();
    bad.svc.startDownload();
    const s = await settle(bad.svc, ['downloading', 'verifying']);
    assert.equal(s.error.code, 'verification_failed');
    assert.equal(bad.requests.length, 0);
  });

  test('verification failure: the download is deleted and never installed (no "install anyway")', async () => {
    const { svc, requests, dir } = setup({ assets: assetsFor('v1.4.0', { digest: 'e'.repeat(64) }) });
    await svc.check();
    svc.startDownload();
    const s = await settle(svc, ['downloading', 'verifying']);
    assert.equal(s.phase, 'failed');
    assert.deepEqual(s.error, {
      code: 'verification_failed',
      message: 'The downloaded KubePilot update could not be verified and will not be installed.',
      retryable: true,
      stage: 'verify',
    });
    assert.equal(requests.length, 0);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'pending')), []);
    await assert.rejects(svc.install(), { code: 'invalid_state' });
  });

  test('no published checksum → refused before downloading', async () => {
    const { svc, fetchImpl } = setup({ assets: assetsFor('v1.4.0', { digest: null }) });
    await svc.check();
    svc.startDownload();
    const s = await settle(svc, ['downloading', 'verifying']);
    assert.equal(s.error.code, 'verification_unavailable');
    assert.equal(
      fetchImpl.calls.some((c) => c.url.endsWith('.exe')),
      false
    );
  });

  test('missing installer for this platform / architecture', async () => {
    const { svc } = setup({ arch: 'arm64' });
    await svc.check();
    const s = svc.startDownload();
    assert.equal(s.phase, 'failed');
    assert.equal(s.error.code, 'no_asset_for_arch');
    assert.match(
      s.error.message,
      /KubePilot v1\.4\.0 is available, but an installer for Windows ARM64 could not be found/
    );
  });

  test('download failure and GitHub unavailable are reported, not thrown', async () => {
    const rel = normalizeRelease(ghRelease('v1.4.0', { assets: assetsFor('v1.4.0') }));
    const failing = createUpdateService({
      currentVersion: '1.3.0',
      releases: { repo: REPO, latest: async () => rel },
      target: detectTarget({ platform: 'win32', arch: 'x64' }),
      install: { kind: 'nsis' },
      updateDir: tmp(),
      host: { available: true, request: async () => ({}) },
      fetchImpl: async () => new Response('', { status: 404 }),
    });
    await failing.check();
    failing.startDownload();
    const s = await settle(failing, ['downloading', 'verifying']);
    assert.equal(s.error.code, 'download_failed');
    assert.equal(s.error.stage, 'download');

    const down = setup({ latest: new Response('', { status: 502 }) });
    const c = await down.svc.check();
    assert.equal(c.phase, 'failed');
    assert.equal(c.error.code, 'github_unavailable');
    assert.equal(c.error.stage, 'check');
  });

  test('no desktop host (dev server / portable copy): can check, cannot download', async () => {
    const { svc } = setup({
      host: {
        available: false,
        request: async () => {
          throw new Error('nope');
        },
      },
    });
    const s = await svc.check();
    assert.equal(s.phase, 'available');
    assert.equal(s.canInstall, false);
    assert.ok(s.installUnavailable);
    assert.throws(() => svc.startDownload(), { code: 'unsupported' });
  });

  test("installer failure from the host is reported with the host's message", async () => {
    const { svc } = setup({
      host: {
        available: true,
        request: async () => {
          const e = new Error(
            'The update could not be installed. Your existing KubePilot installation has not been modified.'
          );
          e.code = 'install_failed';
          throw Object.assign(e, { name: 'UpdateError' });
        },
      },
    });
    await svc.check();
    svc.startDownload();
    await settle(svc, ['downloading', 'verifying']);
    const s = await svc.install();
    assert.equal(s.phase, 'failed');
    assert.equal(s.error.stage, 'install');
  });
});

describe('desktop host bridge', () => {
  test('request → reply round trip, error mapping, and no host', async () => {
    const port = new EventEmitter();
    port.postMessage = (msg) =>
      setImmediate(() =>
        port.emit('message', {
          data:
            msg.type === 'install'
              ? { kpUpdate: 1, id: msg.id, ok: true, result: { installed: true } }
              : { kpUpdate: 1, id: msg.id, ok: false, error: { code: 'restart_failed', message: 'nope' } },
        })
      );
    const bridge = createHostBridge(port);
    assert.equal(bridge.available, true);
    assert.deepEqual(await bridge.request('install', {}), { installed: true });
    await assert.rejects(bridge.request('relaunch'), { code: 'restart_failed', message: 'nope' });
    await assert.rejects(createHostBridge(null).request('install'), { code: 'unsupported' });
  });
});

describe('installers (mocked — nothing is installed)', () => {
  test('Windows NSIS: silent update switches, detached launch', async () => {
    assert.deepEqual(nsisArgs({ relaunch: true }), ['--updated', '/S', '--force-run']);
    assert.deepEqual(nsisArgs({ relaunch: false }), ['--updated', '/S']);
    const calls = [];
    const fakeSpawn = (file, args, opts) => {
      calls.push({ file, args, opts });
      const child = new EventEmitter();
      child.unref = () => {
        child.unrefd = true;
      };
      setImmediate(() => child.emit('spawn'));
      return child;
    };
    await launchNsisInstaller('C:\\cache\\KubePilot-windows.exe', { relaunch: true, spawnImpl: fakeSpawn });
    assert.deepEqual(calls[0].args, ['--updated', '/S', '--force-run']);
    assert.equal(calls[0].opts.detached, true);
    const failSpawn = () => {
      const c = new EventEmitter();
      setImmediate(() => c.emit('error', Object.assign(new Error('blocked'), { code: 'EACCES' })));
      return c;
    };
    await assert.rejects(launchNsisInstaller('x.exe', { spawnImpl: failSpawn }), {
      code: 'installer_launch_failed',
    });
  });

  test('detects how KubePilot is installed', () => {
    const exists = (set) => (p) => set.has(p);
    assert.equal(detectInstall({ isPackaged: false }).reason, 'development');
    assert.equal(
      detectInstall({
        platform: 'win32',
        isPackaged: true,
        execPath: 'C:\\Users\\u\\AppData\\Local\\Programs\\kubepilot\\KubePilot.exe',
        existsSync: exists(
          new Set(['C:\\Users\\u\\AppData\\Local\\Programs\\kubepilot\\Uninstall KubePilot.exe'])
        ),
      }).kind,
      'nsis'
    );
    assert.equal(
      detectInstall({
        platform: 'win32',
        isPackaged: true,
        execPath: 'D:\\release\\win-unpacked\\KubePilot.exe',
        existsSync: exists(new Set()),
      }).reason,
      'portable'
    );
    assert.deepEqual(
      detectInstall({
        platform: 'darwin',
        isPackaged: true,
        execPath: '/Applications/KubePilot.app/Contents/MacOS/KubePilot',
      }),
      { kind: 'dmg', appPath: '/Applications/KubePilot.app' }
    );
    assert.equal(
      detectInstall({
        platform: 'darwin',
        isPackaged: true,
        execPath: '/Volumes/KubePilot/KubePilot.app/Contents/MacOS/KubePilot',
      }).reason,
      'dmg'
    );
    assert.equal(
      detectInstall({
        platform: 'darwin',
        isPackaged: true,
        execPath: '/private/var/folders/x/AppTranslocation/1/d/KubePilot.app/Contents/MacOS/KubePilot',
      }).reason,
      'translocated'
    );
    assert.deepEqual(
      detectInstall({
        platform: 'linux',
        isPackaged: true,
        execPath: '/tmp/.mount_x/kubepilot',
        env: { APPIMAGE: '/home/u/Apps/KubePilot.AppImage' },
        existsSync: exists(new Set(['/home/u/Apps/KubePilot.AppImage'])),
      }),
      { kind: 'appimage', appPath: '/home/u/Apps/KubePilot.AppImage' }
    );
    assert.equal(
      detectInstall({
        platform: 'linux',
        isPackaged: true,
        execPath: '/opt/KubePilot/kubepilot',
        env: {},
        existsSync: exists(new Set(['/var/lib/dpkg/info/kubepilot.list'])),
      }).kind,
      'deb'
    );
    assert.equal(
      macBundlePath('/Applications/KubePilot.app/Contents/MacOS/KubePilot'),
      '/Applications/KubePilot.app'
    );
  });

  test('Linux .deb: pkexec dpkg -i; a dismissed password prompt is a permission error', async () => {
    const runs = [];
    await installDeb({
      file: '/home/u/.cache/kubepilot-updater/pending/KubePilot-linux.deb',
      existsSync: () => true,
      run: async (cmd, args) => {
        runs.push([cmd, ...args]);
      },
    });
    assert.deepEqual(runs[0], [
      '/usr/bin/pkexec',
      '/usr/bin/dpkg',
      '-i',
      '/home/u/.cache/kubepilot-updater/pending/KubePilot-linux.deb',
    ]);
    await assert.rejects(
      installDeb({
        file: 'x.deb',
        existsSync: () => true,
        run: async () => {
          throw Object.assign(new Error('dismissed'), { code: 126 });
        },
      }),
      { code: 'permission_denied' }
    );
    await assert.rejects(
      installDeb({
        file: 'x.deb',
        existsSync: () => true,
        run: async () => {
          throw Object.assign(new Error('dpkg failed'), { code: 1, stderr: 'broken' });
        },
      }),
      { code: 'install_failed' }
    );
    await assert.rejects(installDeb({ file: 'x.deb', existsSync: () => false }), {
      code: 'permission_denied',
    });
  });

  test('Linux AppImage: replaced by an atomic rename in its own folder (temp files only)', async () => {
    const dir = tmp();
    const target = path.join(dir, 'KubePilot.AppImage');
    const update = path.join(dir, 'new.AppImage');
    fs.writeFileSync(target, 'old');
    fs.writeFileSync(update, 'new');
    const posixFs = { ...fs.promises }; // path.posix joins work for POSIX test paths only
    if (process.platform !== 'win32') {
      await installAppImage({ file: update, appPath: target, fsImpl: posixFs });
      assert.equal(fs.readFileSync(target, 'utf8'), 'new');
      assert.equal(fs.statSync(target).mode & 0o111, 0o111);
    }
    await assert.rejects(
      installAppImage({ file: update, appPath: '/nonexistent-kp-dir/KubePilot.AppImage' }),
      { code: 'permission_denied' }
    );
  });

  test('macOS: copy next to the bundle, swap by rename, roll back on failure', async () => {
    const ops = [];
    const fakeFs = {
      mkdir: async () => {},
      mkdtemp: async (p) => `${p}X`,
      readdir: async () => ['KubePilot.app'],
      access: async () => {},
      rm: async (p) => {
        ops.push(['rm', p]);
      },
      rename: async (a, b) => {
        ops.push(['rename', a, b]);
        if (fakeFs.failSwap && a.includes('.update-')) throw new Error('EXDEV');
      },
    };
    const runs = [];
    const run = async (cmd, args) => {
      runs.push([cmd, ...args]);
    };
    await installDmg({
      file: '/c/KubePilot-macos.dmg',
      appPath: '/Applications/KubePilot.app',
      workDir: '/c/work',
      run,
      fsImpl: fakeFs,
    });
    assert.deepEqual(runs[0].slice(0, 2), ['/usr/bin/hdiutil', 'attach']);
    assert.deepEqual(runs[1], [
      '/usr/bin/ditto',
      '/c/work/mnt-X/KubePilot.app',
      `/Applications/.KubePilot.app.update-${process.pid}`,
    ]);
    assert.deepEqual(runs.at(-1).slice(0, 2), ['/usr/bin/hdiutil', 'detach']);
    const renames = ops.filter((o) => o[0] === 'rename');
    assert.deepEqual(renames, [
      ['rename', '/Applications/KubePilot.app', `/Applications/.KubePilot.app.previous-${process.pid}`],
      ['rename', `/Applications/.KubePilot.app.update-${process.pid}`, '/Applications/KubePilot.app'],
    ]);
    // A failed swap puts the old bundle back.
    ops.length = 0;
    fakeFs.failSwap = true;
    await assert.rejects(
      installDmg({
        file: '/c/KubePilot-macos.dmg',
        appPath: '/Applications/KubePilot.app',
        workDir: '/c/work',
        run,
        fsImpl: fakeFs,
      }),
      { code: 'install_failed' }
    );
    assert.deepEqual(ops.filter((o) => o[0] === 'rename').at(-1), [
      'rename',
      `/Applications/.KubePilot.app.previous-${process.pid}`,
      '/Applications/KubePilot.app',
    ]);
    // Paths are shell-quoted for the administrator (osascript) path.
    assert.match(
      macSwapScript({ src: "/v/K'P.app", stage: '/A/.s', appPath: '/A/K.app', backup: '/A/.b' }),
      /'\/v\/K'\\''P\.app'/
    );
  });
});
