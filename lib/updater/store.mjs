// The Microsoft Store, asked which version of K8Board it has. Windows copies
// are installed and updated by the Store, so that is the one place "Check for
// Updates" asks on Windows: K8Board's entry in the Store's public catalog,
// named by its Store ID. The request carries that ID and nothing about the
// user, the device or its clusters.
//
// The Store's own update API (Windows.Services.Store) answers only code
// running inside the app package; K8Board's backend and anything it starts
// run outside it, so the catalog is read instead. When it can't be read, the
// caller sends the user to K8Board's Store page.
import { updateError, UpdateError } from './errors.mjs';
import { compareVersions } from './version.mjs';

/** K8Board in the Microsoft Store (Partner Center → Product identity → Store ID). */
export const MS_STORE_PRODUCT_ID = '9N63V5DDVL9F';
export const STORE_CATALOG = 'https://displaycatalog.mp.microsoft.com/v7.0/products';
const CATALOG_HOST = /^displaycatalog\.mp\.microsoft\.com$/i;
const PRODUCT_ID = /^[A-Za-z0-9]{12}$/;
const PACKAGE_VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5}$/;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGES = 200;
// process.arch → the architecture names the catalog uses.
const STORE_ARCH = { x64: 'x64', arm64: 'arm64', ia32: 'x86', arm: 'arm' };

/** "Name_1.8.5.0_x64__publisherid" → "1.8.5.0"; null when it has no such version. */
export function packageVersionOf(fullName) {
  const version = typeof fullName === 'string' ? fullName.split('_')[1] : null;
  return version && PACKAGE_VERSION.test(version) ? version : null;
}

/** A package version's first three parts: "1.8.5.0" → "1.8.5" (the app's own version). */
const appVersionOf = (packageVersion) => packageVersion.split('.').slice(0, 3).map(Number).join('.');

/**
 * The newest K8Board package in a catalog answer, for this architecture when
 * the catalog lists one (else the newest of any): { version, packageVersion }.
 * Throws invalid_response when the answer isn't K8Board's entry or names no package.
 */
export function latestStorePackage(body, { productId = MS_STORE_PRODUCT_ID, arch = process.arch } = {}) {
  const product = body?.Product;
  if (!product || String(product.ProductId).toUpperCase() !== productId.toUpperCase())
    throw updateError('invalid_response', undefined, { detail: 'not the product asked for' });
  const found = [];
  for (const availability of Array.isArray(product.DisplaySkuAvailabilities) ? product.DisplaySkuAvailabilities : []) {
    const packages = availability?.Sku?.Properties?.Packages;
    for (const pkg of Array.isArray(packages) ? packages : []) {
      const packageVersion = packageVersionOf(pkg?.PackageFullName);
      if (!packageVersion) continue;
      const archs = Array.isArray(pkg.Architectures) ? pkg.Architectures.map((a) => String(a).toLowerCase()) : [];
      found.push({ packageVersion, version: appVersionOf(packageVersion), archs });
      if (found.length === MAX_PACKAGES) break;
    }
  }
  const wanted = STORE_ARCH[arch];
  const mine = found.filter((p) => p.archs.includes(wanted) || p.archs.includes('neutral'));
  const pool = mine.length ? mine : found;
  if (!pool.length) throw updateError('invalid_response', undefined, { detail: 'the product lists no package' });
  const newest = pool.reduce((a, b) => (compareVersions(b.version, a.version) > 0 ? b : a));
  return { version: newest.version, packageVersion: newest.packageVersion };
}

/**
 * createStoreClient({ productId, fetchImpl, userAgent, timeoutMs, arch }) →
 * { productId, latest() }. latest() resolves { version, packageVersion } or
 * rejects with an UpdateError (offline, timeout, invalid_response).
 */
export function createStoreClient({
  productId = MS_STORE_PRODUCT_ID,
  fetchImpl = globalThis.fetch,
  userAgent = 'K8Board',
  timeoutMs = 12_000,
  arch = process.arch,
} = {}) {
  if (!PRODUCT_ID.test(String(productId))) throw new TypeError('not a Microsoft Store product ID');
  // The same catalog entry everywhere: the market and language are fixed, so
  // the request says nothing about where the user is.
  const url = `${STORE_CATALOG}/${productId}?market=US&languages=en-US`;

  async function latest() {
    let res;
    try {
      res = await fetchImpl(url, {
        headers: { Accept: 'application/json', 'User-Agent': userAgent },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw updateError(timedOut ? 'timeout' : 'offline', undefined, {
        detail: err?.cause?.code || err?.code || err?.name || 'request failed',
        cause: err,
      });
    }
    if (res.url && !isCatalogUrl(res.url))
      throw updateError('invalid_response', undefined, { detail: 'unexpected response origin' });
    if (!res.ok) throw updateError('invalid_response', undefined, { detail: `HTTP ${res.status}` });
    if (Number(res.headers?.get?.('content-length')) > MAX_BYTES)
      throw updateError('invalid_response', undefined, { detail: 'answer too large' });
    let body;
    try {
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new RangeError('answer too large');
      body = JSON.parse(text);
    } catch (err) {
      if (err instanceof UpdateError) throw err;
      throw updateError('invalid_response', undefined, { detail: err?.message || 'body is not JSON', cause: err });
    }
    return latestStorePackage(body, { productId, arch });
  }

  return { productId, latest };
}

function isCatalogUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && CATALOG_HOST.test(u.hostname);
  } catch {
    return false;
  }
}
