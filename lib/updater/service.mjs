// The update workflow, run by the backend:
//
//   check → (up-to-date | available) → download → verify → install → restart
//
// One instance per backend; the UI polls `snapshot()`. Downloading and
// verifying happen here; installing and restarting are delegated to the
// desktop host (lib/updater/host.mjs → electron/update-host.cjs), which
// re-checks the file before it runs anything.
//
// Phases: idle, checking, up-to-date, available, downloading, verifying,
// ready (Windows: verified, waiting to install on restart), installing,
// installed (macOS/Linux: restart to finish), scheduled (Windows: installs
// when KubePilot quits), restarting, cancelled, failed.
import fs from 'node:fs/promises';
import path from 'node:path';
import { errorBody, updateError, UpdateError } from './errors.mjs';
import { compareVersions, normalizeVersion } from './version.mjs';
import { selectAsset } from './platform.mjs';
import { downloadFile, fetchSmallText } from './download.mjs';
import { CHECKSUMS_ASSET, digestsMatch, expectedSha256, parseChecksums } from './verify.mjs';

const BUSY = new Set(['checking', 'downloading', 'verifying', 'installing', 'restarting']);
const SAFE_ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/**
 * createUpdateService({
 *   currentVersion,          // the running app's version (VERSION / package.json)
 *   releases,                // createReleaseService(...)
 *   target,                  // detectTarget(...) → { os, arch, installKind, label }
 *   install,                 // { kind, message } from the desktop host (kind null → can't install)
 *   updateDir,               // where installers are downloaded
 *   host,                    // createHostBridge(...)
 *   log, product, fetchImpl, userAgent,
 * })
 */
export function createUpdateService({
  currentVersion,
  releases,
  target,
  install = {},
  updateDir,
  host,
  log,
  product = 'KubePilot',
  fetchImpl = globalThis.fetch,
  userAgent = 'KubePilot',
}) {
  let state = { phase: 'idle', error: null, progress: null, dryRun: false };
  let release = null; // the newer release being offered
  let job = null; // { controller, asset, file, sha256 }

  const canInstall = !!(install.kind && host?.available && updateDir);
  const installUnavailable = canInstall
    ? null
    : install.message || 'Updates can only be installed from the KubePilot desktop app.';
  const set = (patch) => {
    state = { ...state, ...patch };
  };

  function fail(err, stage) {
    const e =
      err instanceof UpdateError
        ? err
        : updateError(stage === 'check' ? 'invalid_response' : 'install_failed', undefined, {
            cause: err,
            detail: err?.message,
          });
    set({ phase: 'failed', progress: null, error: { ...errorBody(e), stage } });
    log?.warn(`update ${stage} failed`, { code: e.code, detail: e.detail, version: release?.version });
    return e;
  }

  function snapshot() {
    return {
      phase: state.phase,
      currentVersion: normalizeVersion(currentVersion) || currentVersion,
      latest: release
        ? {
            version: release.version,
            tag: release.tag,
            name: release.name,
            publishedAt: release.publishedAt,
            htmlUrl: release.htmlUrl,
          }
        : null,
      target: { os: target.os, arch: target.arch, label: target.label, installKind: target.installKind },
      canInstall,
      installUnavailable,
      // Windows installs once KubePilot has closed; macOS/Linux install in place.
      installMode: install.kind === 'nsis' ? 'on-restart' : 'in-place',
      asset: job?.asset ? { name: job.asset.name, size: job.asset.size } : null,
      progress: state.progress,
      error: state.error,
      dryRun: state.dryRun,
    };
  }

  async function check({ fresh = true } = {}) {
    if (BUSY.has(state.phase)) throw updateError('busy', 'An update is already in progress.');
    set({ phase: 'checking', error: null, progress: null, dryRun: false });
    const cur = normalizeVersion(currentVersion);
    log?.info('update check started', {
      currentVersion: cur || currentVersion,
      platform: target.label,
      installKind: install.kind || 'none',
      repo: releases.repo,
    });
    try {
      if (!cur)
        throw updateError('malformed_version', `KubePilot can't read its own version ("${currentVersion}").`);
      const latest = await releases.latest({ fresh });
      log?.info('latest release', { currentVersion: cur, latestVersion: latest.version });
      if (compareVersions(latest.version, cur) <= 0) {
        release = null;
        set({ phase: 'up-to-date' });
        log?.info('update not available', { currentVersion: cur });
      } else {
        release = latest;
        job = null;
        set({ phase: 'available' });
        log?.info('update available', { currentVersion: cur, latestVersion: latest.version });
      }
    } catch (err) {
      fail(err, 'check');
    }
    return snapshot();
  }

  async function runDownload(j) {
    let stage = 'download';
    try {
      // The expected checksum comes first: without one there is nothing worth downloading.
      let checksums = null;
      const sums = release.assets.find((a) => a.name === CHECKSUMS_ASSET);
      if (sums) {
        try {
          checksums = parseChecksums(
            await fetchSmallText(sums.url, { fetchImpl, signal: j.controller.signal, userAgent })
          );
        } catch (err) {
          if (err?.code === 'cancelled' || !j.asset.digest) throw err;
          log?.warn('SHA256SUMS.txt unavailable; verifying with the GitHub asset digest', {
            detail: err?.detail || err?.message,
          });
        }
      }
      const expected = expectedSha256(j.asset, checksums);

      await fs.rm(path.dirname(j.file), { recursive: true, force: true });
      await fs.mkdir(path.dirname(j.file), { recursive: true });
      log?.info('update download started', {
        asset: j.asset.name,
        size: j.asset.size,
        version: release.version,
      });
      const { sha256, bytes } = await downloadFile(j.asset.url, j.file, {
        fetchImpl,
        userAgent,
        signal: j.controller.signal,
        expectedSize: j.asset.size || undefined,
        onProgress: ({ received, total }) => {
          if (job === j && state.phase === 'downloading') set({ progress: { received, total } });
        },
      });
      log?.info('update download completed', { asset: j.asset.name, bytes });
      if (j.controller.signal.aborted) throw updateError('cancelled');

      stage = 'verify';
      set({ phase: 'verifying' });
      if (!digestsMatch(sha256, expected.sha256)) {
        await fs.rm(j.file, { force: true }).catch(() => {});
        log?.warn('update verification failed', {
          asset: j.asset.name,
          expected: expected.sha256,
          actual: sha256,
          sources: expected.sources.join(','),
        });
        throw updateError('verification_failed');
      }
      j.sha256 = sha256;
      log?.info('update verified', { asset: j.asset.name, sha256, sources: expected.sources.join(',') });

      stage = 'install';
      if (j.controller.signal.aborted) throw updateError('cancelled');
      if (install.kind === 'nsis') set({ phase: 'ready' });
      else await doInstall('now');
    } catch (err) {
      if (err?.code === 'cancelled') {
        await fs.rm(j.file, { force: true }).catch(() => {});
        if (job === j) set({ phase: 'cancelled', progress: null });
        log?.info('update download cancelled', { asset: j.asset.name });
        return;
      }
      if (stage !== 'install') await fs.rm(j.file, { force: true }).catch(() => {});
      if (job === j) fail(err, stage);
    }
  }

  function startDownload() {
    const retry =
      state.phase === 'failed' && ['select', 'download', 'verify', 'install'].includes(state.error?.stage);
    if (!release || !(state.phase === 'available' || state.phase === 'cancelled' || retry)) {
      throw updateError('invalid_state', 'There is no update to download. Check for updates first.');
    }
    if (!canInstall) throw updateError('unsupported', installUnavailable);
    let asset;
    try {
      asset = selectAsset(release.assets, target, { product, version: release.version });
      if (!SAFE_ASSET_NAME.test(asset.name))
        throw updateError('invalid_response', undefined, { detail: `unsafe asset name ${asset.name}` });
    } catch (err) {
      fail(err, 'select');
      return snapshot();
    }
    log?.info('update asset selected', {
      platform: target.label,
      asset: asset.name,
      size: asset.size,
      version: release.version,
    });
    job = {
      controller: new AbortController(),
      asset,
      file: path.join(updateDir, 'pending', asset.name),
      sha256: null,
    };
    set({ phase: 'downloading', error: null, progress: { received: 0, total: asset.size }, dryRun: false });
    runDownload(job);
    return snapshot();
  }

  async function doInstall(when) {
    set({ phase: 'installing', progress: null });
    log?.info('update installer started', { kind: install.kind, version: release.version, when });
    try {
      const result = await host.request(
        'install',
        { file: job.file, sha256: job.sha256, version: release.version, kind: install.kind, when },
        { timeoutMs: 20 * 60_000 }
      );
      const dryRun = !!result?.dryRun;
      if (install.kind === 'nsis') {
        set({ phase: when === 'on-quit' ? 'scheduled' : 'restarting', dryRun });
        log?.info(
          when === 'on-quit'
            ? 'update will install when KubePilot quits'
            : 'update installer launched; KubePilot is restarting',
          { version: release.version, dryRun }
        );
      } else {
        set({ phase: 'installed', dryRun });
        log?.info('update installed', { version: release.version, dryRun });
      }
    } catch (err) {
      fail(err, 'install');
    }
    return snapshot();
  }

  return {
    snapshot,
    check,
    startDownload,

    cancel() {
      if ((state.phase === 'downloading' || state.phase === 'verifying') && job) {
        job.controller.abort(updateError('cancelled'));
        set({ phase: 'cancelled', progress: null });
      }
      return snapshot();
    },

    /** Windows: install the verified update now (KubePilot restarts) or when it quits. */
    async install({ when = 'now' } = {}) {
      if (state.phase !== 'ready' || !job?.sha256)
        throw updateError('invalid_state', 'There is no verified update ready to install.');
      return doInstall(when === 'on-quit' ? 'on-quit' : 'now');
    },

    async restart() {
      if (state.phase !== 'installed')
        throw updateError('invalid_state', 'There is no installed update waiting for a restart.');
      log?.info('restart requested', { version: release?.version });
      try {
        await host.request('relaunch', {}, { timeoutMs: 15_000 });
        set({ phase: 'restarting' });
      } catch (err) {
        fail(
          err instanceof UpdateError && err.code !== 'unsupported'
            ? updateError('restart_failed', undefined, { detail: err.detail || err.message })
            : err,
          'restart'
        );
      }
      return snapshot();
    },

    async releaseNotes({ fresh = false } = {}) {
      const r = await releases.latest({ fresh });
      return {
        version: r.version,
        tag: r.tag,
        name: r.name,
        publishedAt: r.publishedAt,
        body: r.body,
        htmlUrl: r.htmlUrl,
      };
    },
  };
}
