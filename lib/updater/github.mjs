// GitHub Releases: the one place KubePilot reads release information from.
// "Show Release Notes" and "Check for Updates" both use createReleaseService().
//
// The repository is the public release repo named in package.json
// (`releaseRepository`, e.g. "jaychandra1/KubePilot"). It is public, so no
// token is sent — anonymous requests (60/hour per IP) are plenty for a
// user-initiated check, and a short cache keeps repeated clicks cheap.
// Only HTTPS to api.github.com; TLS verification is never relaxed.
import { updateError, UpdateError } from './errors.mjs';
import { compareVersions, isStableVersion, normalizeVersion, parseVersion } from './version.mjs';

export const GITHUB_API = 'https://api.github.com';
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const MAX_BODY_CHARS = 200_000; // GitHub caps release bodies at 125,000
const MAX_ASSETS = 100;
const SHA256_DIGEST = /^sha256:([0-9a-f]{64})$/i;
const NETWORK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT']);

/**
 * The release repository: `KUBEPILOT_UPDATE_REPO` (for testing against a
 * scratch repo) or package.json `releaseRepository`. Returns null when
 * neither is a valid "owner/repo".
 */
export function releaseRepository({ pkg, env = process.env } = {}) {
  for (const cand of [env.KUBEPILOT_UPDATE_REPO, pkg?.releaseRepository]) {
    const v = typeof cand === 'string' ? cand.trim() : '';
    if (REPO_RE.test(v)) return v;
  }
  return null;
}

const isHttpsUrl = (u, hostRe) => {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && (!hostRe || hostRe.test(url.hostname));
  } catch {
    return false;
  }
};

/**
 * Normalise one GitHub release object into the model the app uses:
 *   { tag, version, name, publishedAt, body, htmlUrl, prerelease, draft,
 *     assets: [{ name, size, url, digest, contentType }] }
 * `digest` is the asset's SHA-256 (hex) when GitHub reports one.
 * Throws invalid_response for a shape that isn't a release and
 * malformed_version when the tag isn't a semantic version.
 */
export function normalizeRelease(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw updateError('invalid_response', undefined, { detail: 'release is not an object' });
  const tag = typeof raw.tag_name === 'string' ? raw.tag_name.trim() : '';
  if (!tag) throw updateError('invalid_response', undefined, { detail: 'release has no tag_name' });
  const version = normalizeVersion(tag);
  if (!version) throw updateError('malformed_version', `The latest KubePilot release is tagged "${tag.slice(0, 40)}", which is not a version number KubePilot can compare.`, { detail: `tag ${tag}` });
  const htmlUrl = typeof raw.html_url === 'string' && isHttpsUrl(raw.html_url, /^github\.com$/i) ? raw.html_url : null;
  const assets = Array.isArray(raw.assets) ? raw.assets.slice(0, MAX_ASSETS) : [];
  return {
    tag,
    version,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 200) : `KubePilot ${version}`,
    publishedAt: typeof raw.published_at === 'string' && !Number.isNaN(Date.parse(raw.published_at)) ? raw.published_at : null,
    body: typeof raw.body === 'string' ? raw.body.slice(0, MAX_BODY_CHARS) : '',
    htmlUrl,
    prerelease: raw.prerelease === true,
    draft: raw.draft === true,
    assets: assets
      .filter((a) => a && typeof a.name === 'string' && typeof a.browser_download_url === 'string' && isHttpsUrl(a.browser_download_url, /^github\.com$/i))
      .map((a) => {
        const m = typeof a.digest === 'string' ? a.digest.trim().match(SHA256_DIGEST) : null;
        return {
          name: a.name,
          size: Number.isFinite(a.size) && a.size >= 0 ? a.size : null,
          url: a.browser_download_url,
          digest: m ? m[1].toLowerCase() : null,
          contentType: typeof a.content_type === 'string' ? a.content_type : null,
        };
      }),
  };
}

/** A published, non-prerelease release whose tag is a stable version. */
export const isStableRelease = (raw) => !!raw && raw.draft !== true && raw.prerelease !== true && typeof raw.tag_name === 'string' && isStableVersion(raw.tag_name.trim());

function networkError(err, timeoutMs) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return updateError('timeout', undefined, { detail: `no response within ${timeoutMs} ms`, cause: err });
  }
  const code = err?.cause?.code || err?.code;
  return updateError('offline', undefined, { detail: code && NETWORK_CODES.has(code) ? code : String(err?.cause?.message || err?.message || err), cause: err });
}

/**
 * createReleaseService({ repo, userAgent, fetchImpl, timeoutMs, cacheMs, log })
 *   .latest({ fresh })  → the newest stable release (model above)
 *   .repo               → "owner/repo"
 */
export function createReleaseService({ repo, userAgent = 'KubePilot', fetchImpl = globalThis.fetch, timeoutMs = 15_000, cacheMs = 60_000, log, now = Date.now } = {}) {
  let cache = null; // { at, release }

  async function getJson(apiPath) {
    const url = `${GITHUB_API}${apiPath}`;
    let res;
    try {
      res = await fetchImpl(url, {
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': userAgent },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw networkError(err, timeoutMs);
    }
    // A renamed repo redirects; only ever accept an answer from the API host.
    if (res.url && !isHttpsUrl(res.url, /^api\.github\.com$/i)) throw updateError('invalid_response', undefined, { detail: `unexpected response origin ${new URL(res.url).host}` });
    if (res.status === 404) return null;
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (res.status === 429 || (res.status === 403 && remaining === '0')) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const when = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : null;
      throw updateError('rate_limited', when
        ? `GitHub is limiting update checks from your network. Please try again after ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
        : undefined, { detail: `HTTP ${res.status}` });
    }
    if (res.status >= 500 || res.status === 403) throw updateError('github_unavailable', undefined, { detail: `HTTP ${res.status}` });
    if (!res.ok) throw updateError('invalid_response', undefined, { detail: `HTTP ${res.status}` });
    try {
      return await res.json();
    } catch (err) {
      throw updateError('invalid_response', undefined, { detail: 'body is not JSON', cause: err });
    }
  }

  async function fetchLatest() {
    // /releases/latest is GitHub's newest published, non-draft, non-prerelease
    // release. It is double-checked (a "-rc.1" tag that wasn't flagged as a
    // prerelease is still a prerelease) and, if it doesn't qualify or doesn't
    // exist, the newest stable entry of the release list is used instead.
    const latest = await getJson(`/repos/${repo}/releases/latest`);
    if (latest !== null && (typeof latest !== 'object' || Array.isArray(latest))) throw updateError('invalid_response', undefined, { detail: 'releases/latest is not an object' });
    if (latest && isStableRelease(latest)) return normalizeRelease(latest);

    const list = await getJson(`/repos/${repo}/releases?per_page=30`);
    if (list === null) {
      if (latest) return normalizeRelease(latest); // throws malformed_version for a bad tag
      throw updateError('no_releases', undefined, { detail: `${repo} has no releases (or does not exist)` });
    }
    if (!Array.isArray(list)) throw updateError('invalid_response', undefined, { detail: 'releases is not an array' });
    const stable = list.filter(isStableRelease);
    if (!stable.length) {
      if (latest && !parseVersion(String(latest.tag_name || '').trim())) return normalizeRelease(latest);
      if (list.some((r) => r && r.draft !== true && typeof r.tag_name === 'string' && !parseVersion(r.tag_name.trim()))) {
        throw updateError('malformed_version', undefined, { detail: 'no release tag is a semantic version' });
      }
      throw updateError('no_releases', 'No stable KubePilot release has been published yet.', { detail: `${list.length} releases, none stable` });
    }
    stable.sort((a, b) => compareVersions(b.tag_name.trim(), a.tag_name.trim()));
    return normalizeRelease(stable[0]);
  }

  return {
    repo,
    async latest({ fresh = false } = {}) {
      if (!repo) throw updateError('unsupported', 'This build of KubePilot has no release repository configured.');
      if (!fresh && cache && now() - cache.at < cacheMs) return cache.release;
      try {
        const release = await fetchLatest();
        cache = { at: now(), release };
        return release;
      } catch (err) {
        const e = err instanceof UpdateError ? err : updateError('invalid_response', undefined, { cause: err, detail: String(err?.message || err) });
        log?.warn('github release lookup failed', { repo, code: e.code, detail: e.detail });
        throw e;
      }
    },
  };
}
