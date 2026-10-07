// Release-asset downloads: HTTPS only, GitHub hosts only, redirects followed
// by hand so every hop is checked, streamed to a ".part" file while the
// SHA-256 is computed, renamed into place only when complete. Cancellable;
// a partial or failed download never leaves a file behind.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { updateError, UpdateError } from './errors.mjs';

// github.com serves /releases/download/… as a redirect to its asset CDN.
const ALLOWED_HOST = /^(?:github\.com|[a-z0-9-]+\.githubusercontent\.com)$/i;
const MAX_REDIRECTS = 5;
const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024; // 1 GiB: far above any KubePilot installer

/** Is this a URL the updater may fetch from? */
export function isAllowedDownloadUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && ALLOWED_HOST.test(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

async function openFollowingRedirects(url, { fetchImpl, signal, userAgent, accept }) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedDownloadUrl(current)) throw updateError('download_failed', undefined, { detail: `refused URL host ${safeHost(current)}` });
    let res;
    try {
      res = await fetchImpl(current, { redirect: 'manual', signal, headers: { 'User-Agent': userAgent, Accept: accept } });
    } catch (err) {
      if (signal?.aborted) throw abortReason(signal);
      throw updateError('download_failed', undefined, { detail: err?.cause?.code || err?.message || String(err), cause: err });
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw updateError('download_failed', undefined, { detail: `HTTP ${res.status} without Location` });
      current = new URL(loc, current).toString();
      continue;
    }
    if (!res.ok) throw updateError('download_failed', undefined, { detail: `HTTP ${res.status} from ${safeHost(current)}` });
    return res;
  }
  throw updateError('download_failed', undefined, { detail: 'too many redirects' });
}

const safeHost = (u) => { try { return new URL(u).host; } catch { return 'invalid URL'; } };

function abortReason(signal) {
  const r = signal?.reason;
  return r instanceof UpdateError ? r : updateError('cancelled');
}

/**
 * Download `url` to `dest`. Returns { bytes, sha256 }.
 *   onProgress({ received, total })  — throttled to ~10/s
 *   expectedSize                      — GitHub's asset size; a mismatch fails
 *   signal                            — abort to cancel (→ UpdateError 'cancelled')
 */
export async function downloadFile(url, dest, { fetchImpl = globalThis.fetch, signal, onProgress, expectedSize, idleTimeoutMs = 60_000, userAgent = 'KubePilot', maxBytes = MAX_INSTALLER_BYTES } = {}) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(abortReason(signal));
  if (signal) {
    if (signal.aborted) throw abortReason(signal);
    signal.addEventListener('abort', onAbort, { once: true });
  }
  let idle;
  const armIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ctrl.abort(updateError('download_failed', 'The download stalled. Please check your network connection and try again.', { detail: `no data for ${idleTimeoutMs} ms` })), idleTimeoutMs);
  };
  const part = `${dest}.part`;
  let fh;
  try {
    armIdle();
    const res = await openFollowingRedirects(url, { fetchImpl, signal: ctrl.signal, userAgent, accept: 'application/octet-stream' });
    const lenHeader = Number(res.headers.get('content-length'));
    const total = Number.isFinite(lenHeader) && lenHeader > 0 ? lenHeader : expectedSize || null;
    if (expectedSize && Number.isFinite(lenHeader) && lenHeader > 0 && lenHeader !== expectedSize) {
      throw updateError('download_failed', undefined, { detail: `size ${lenHeader} != expected ${expectedSize}` });
    }
    if (total && total > maxBytes) throw updateError('download_failed', undefined, { detail: `size ${total} exceeds limit` });
    if (!res.body) throw updateError('download_failed', undefined, { detail: 'empty response body' });

    await fs.mkdir(path.dirname(dest), { recursive: true });
    fh = await fs.open(part, 'w', 0o600);
    const hash = crypto.createHash('sha256');
    let received = 0;
    let lastReport = 0;
    onProgress?.({ received: 0, total });
    for await (const chunk of res.body) {
      if (ctrl.signal.aborted) throw ctrl.signal.reason;
      armIdle();
      const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      received += buf.length;
      if (received > maxBytes || (expectedSize && received > expectedSize)) throw updateError('download_failed', undefined, { detail: 'more data than expected' });
      hash.update(buf);
      await fh.write(buf);
      const t = Date.now();
      if (t - lastReport > 100) { lastReport = t; onProgress?.({ received, total }); }
    }
    if (ctrl.signal.aborted) throw ctrl.signal.reason;
    if (expectedSize && received !== expectedSize) throw updateError('download_failed', undefined, { detail: `received ${received} of ${expectedSize} bytes` });
    await fh.close();
    fh = null;
    await fs.rename(part, dest);
    onProgress?.({ received, total: total || received });
    return { bytes: received, sha256: hash.digest('hex') };
  } catch (err) {
    if (fh) await fh.close().catch(() => {});
    await fs.rm(part, { force: true }).catch(() => {});
    if (err instanceof UpdateError) throw err;
    // An aborted body read throws a DOMException; report why it was aborted
    // (cancel, stall) instead.
    if (ctrl.signal.aborted) throw ctrl.signal.reason instanceof UpdateError ? ctrl.signal.reason : updateError('cancelled');
    throw updateError('download_failed', undefined, { detail: err?.message || String(err), cause: err });
  } finally {
    clearTimeout(idle);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Fetch a small text asset (e.g. SHA256SUMS.txt) into memory, size-capped. */
export async function fetchSmallText(url, { fetchImpl = globalThis.fetch, signal, maxBytes = 256 * 1024, userAgent = 'KubePilot', timeoutMs = 30_000 } = {}) {
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const res = await openFollowingRedirects(url, { fetchImpl, signal: sig, userAgent, accept: 'text/plain, application/octet-stream' });
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of res.body) {
      size += chunk.byteLength;
      if (size > maxBytes) throw updateError('download_failed', undefined, { detail: 'checksum file too large' });
      chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    }
  } catch (err) {
    if (err instanceof UpdateError) throw err;
    if (sig.aborted) throw signal?.aborted ? abortReason(signal) : updateError('download_failed', undefined, { detail: 'checksum download timed out' });
    throw updateError('download_failed', undefined, { detail: err?.message || String(err), cause: err });
  }
  return Buffer.concat(chunks).toString('utf8');
}
