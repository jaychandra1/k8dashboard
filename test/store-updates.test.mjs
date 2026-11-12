// Windows: "Check for Updates" asks the Microsoft Store which version of
// K8Board it has (lib/updater/store.mjs reads K8Board's entry in the Store's
// public catalog). The network is a stand-in: nothing here contacts anyone.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {
  MS_STORE_PRODUCT_ID,
  STORE_CATALOG,
  createStoreClient,
  latestStorePackage,
  packageVersionOf,
} from '../lib/updater/store.mjs';
import { createUpdates } from '../lib/updater/routes.mjs';
import { ROOT_DIR } from '../lib/paths.mjs';

const URL_ASKED = `${STORE_CATALOG}/${MS_STORE_PRODUCT_ID}?market=US&languages=en-US`;
const pkg = (version, archs = ['x64']) => ({
  PackageFullName: `Publisher.K8Board_${version}_${archs[0]}__abcdefghjkmnp`,
  Architectures: archs,
  PackageFormat: 'Msix',
});
// The shape of the catalog's answer: one product, its SKUs, each SKU's packages.
const catalog = (packages, { id = MS_STORE_PRODUCT_ID, skus = 2 } = {}) => ({
  Product: {
    ProductId: id,
    ProductKind: 'Application',
    DisplaySkuAvailabilities: Array.from({ length: skus }, (_, i) => ({
      Sku: { SkuId: `001${i}`, Properties: { Packages: packages } },
    })),
  },
});
const answering = (body, init = {}) => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
      ...init,
    });
  };
  return { fetchImpl, calls };
};

describe('reading the Store catalog', () => {
  test('a package full name carries the version', () => {
    assert.equal(packageVersionOf('Publisher.K8Board_1.8.5.0_x64__abcdefghjkmnp'), '1.8.5.0');
    for (const bad of ['Publisher.K8Board', 'Publisher.K8Board_1.8.5_x64__x', 'Publisher.K8Board_latest_x64__x', '', null, 7])
      assert.equal(packageVersionOf(bad), null, String(bad));
  });

  test('the newest package wins, compared as numbers, across every SKU', () => {
    const body = catalog([pkg('1.8.5.0'), pkg('1.10.0.0'), pkg('1.9.9.0')]);
    assert.deepEqual(latestStorePackage(body, { arch: 'x64' }), { version: '1.10.0', packageVersion: '1.10.0.0' });
  });

  test("this machine's architecture is preferred; neutral counts; without a match, the newest of any", () => {
    const body = catalog([pkg('1.9.0.0', ['arm64']), pkg('1.8.5.0', ['x64']), pkg('1.8.0.0', ['neutral'])]);
    assert.equal(latestStorePackage(body, { arch: 'x64' }).version, '1.8.5');
    assert.equal(latestStorePackage(body, { arch: 'arm64' }).version, '1.9.0');
    assert.equal(latestStorePackage(catalog([pkg('1.9.0.0', ['arm64'])]), { arch: 'x64' }).version, '1.9.0');
    assert.equal(latestStorePackage(catalog([pkg('1.7.0.0', ['x86'])]), { arch: 'ia32' }).version, '1.7.0');
  });

  test('an answer about another product, or with no readable package, is refused', () => {
    assert.throws(() => latestStorePackage(catalog([pkg('9.9.9.0')], { id: '9WZDNCRFJ3TJ' })), { code: 'invalid_response' });
    assert.throws(() => latestStorePackage(catalog([])), { code: 'invalid_response' });
    assert.throws(() => latestStorePackage(catalog([{ PackageFullName: 'junk' }, null, {}])), { code: 'invalid_response' });
    for (const body of [null, {}, { Product: null }, [], 'text']) assert.throws(() => latestStorePackage(body), { code: 'invalid_response' });
  });
});

describe('asking the Store', () => {
  test("one request: K8Board's catalog entry, nothing about the user, no redirects followed", async () => {
    const { fetchImpl, calls } = answering(catalog([pkg('1.8.6.0')]));
    const store = createStoreClient({ fetchImpl, userAgent: 'K8Board/1.8.5 (win32; x64)', arch: 'x64' });
    assert.deepEqual(await store.latest(), { version: '1.8.6', packageVersion: '1.8.6.0' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, URL_ASKED);
    assert.equal(new URL(calls[0].url).hostname, 'displaycatalog.mp.microsoft.com');
    assert.equal(calls[0].opts.redirect, 'error');
    assert.equal(calls[0].opts.method, undefined);
    assert.equal(calls[0].opts.body, undefined);
    assert.deepEqual(Object.keys(calls[0].opts.headers).sort(), ['Accept', 'User-Agent']);
    // Fixed market and language: the request says nothing about where the user is.
    assert.doesNotMatch(calls[0].url, new RegExp(os.userInfo().username.replace(/[^\w]/g, '.'), 'i'));
  });

  test('offline, slow, failing or unreadable answers are typed errors, never a version', async () => {
    const failing = (err) => createStoreClient({ fetchImpl: async () => { throw err; } });
    await assert.rejects(
      failing(new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) })).latest(),
      (e) => e.code === 'offline' && e.detail === 'ENOTFOUND'
    );
    await assert.rejects(failing(new DOMException('timed out', 'TimeoutError')).latest(), { code: 'timeout' });
    await assert.rejects(createStoreClient(answering('', { status: 503 })).latest(), { code: 'invalid_response' });
    await assert.rejects(createStoreClient(answering('<html>')).latest(), { code: 'invalid_response' });
    await assert.rejects(createStoreClient(answering(catalog([]))).latest(), { code: 'invalid_response' });
    const big = answering(catalog([pkg('1.8.6.0')]), { headers: { 'content-length': String(64 * 1024 * 1024) } });
    await assert.rejects(createStoreClient(big).latest(), { code: 'invalid_response' });
  });

  test('an answer from any other host is refused', async () => {
    const elsewhere = async () => {
      const res = new Response(JSON.stringify(catalog([pkg('9.9.9.0')])), { status: 200 });
      Object.defineProperty(res, 'url', { value: 'https://example.com/v7.0/products/x' });
      return res;
    };
    await assert.rejects(createStoreClient({ fetchImpl: elsewhere }).latest(), { code: 'invalid_response' });
  });

  test('only a Store product ID is accepted', () => {
    for (const bad of ['', '9N63V5DDVL9F/../x', 'https://example.com', '9N63V5DDVL9', null])
      assert.throws(() => createStoreClient({ productId: bad }), TypeError, String(bad));
    assert.equal(createStoreClient().productId, '9N63V5DDVL9F');
  });
});

describe('a Windows copy (the desktop app marks it as a Store copy)', () => {
  const quiet = { info() {}, warn() {}, error() {} };
  const run = async ({ version, fetchImpl }) => {
    const { service } = createUpdates({
      rootDir: ROOT_DIR,
      version,
      log: quiet,
      env: { K8BOARD_INSTALL_MANAGED_BY: 'store' },
      fetchImpl,
    });
    return service.check();
  };

  test('Check for Updates asks the Microsoft Store and nobody else', async () => {
    const { fetchImpl, calls } = answering(catalog([pkg('1.8.6.0')]));
    const newer = await run({ version: '1.8.5', fetchImpl });
    assert.deepEqual([newer.phase, newer.managedBy, newer.latest.version], ['available', 'store', '1.8.6']);
    const same = await run({ version: '1.8.6', fetchImpl });
    assert.equal(same.phase, 'up-to-date');
    assert.deepEqual([...new Set(calls.map((c) => c.url))], [URL_ASKED]);
    assert.equal(calls.some((c) => /github/i.test(c.url)), false);
  });

  test("when the Store can't be reached the answer is \"ask the Store\", not an error", async () => {
    const s = await run({ version: '1.8.5', fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    assert.deepEqual([s.phase, s.latest], ['store', null]);
  });

  test('a copy that is not marked as a Store copy makes no request at all', async () => {
    const { fetchImpl, calls } = answering(catalog([pkg('9.9.9.0')]));
    const { service } = createUpdates({ rootDir: ROOT_DIR, version: '1.8.5', log: quiet, env: {}, fetchImpl });
    assert.deepEqual(await service.check(), { phase: 'unavailable', currentVersion: '1.8.5', latest: null, managedBy: null });
    assert.deepEqual(calls, []);
  });
});
