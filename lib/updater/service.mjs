// "Check for Updates", run by the backend. K8Board never downloads or installs
// an update itself, and asks no release server:
//
//   * a copy the Microsoft Store keeps up to date (every Windows copy:
//     managedBy 'store') asks the Store which version is current
//     (lib/updater/store.mjs) → up-to-date | available. When the Store can't
//     be asked (offline, an answer K8Board can't read) the phase is 'store',
//     not a failure: the dialog sends the user to K8Board's Store page;
//   * any other copy has no store to ask → unavailable.
//
// One instance per backend. Phases: idle, checking, up-to-date, available,
// store, unavailable.
import { updateError } from './errors.mjs';
import { compareVersions, normalizeVersion } from './version.mjs';

/**
 * createUpdateService({
 *   currentVersion,   // the running app's version (VERSION / package.json)
 *   managedBy,        // 'store' — the Microsoft Store delivers this copy's updates; else null
 *   store,            // createStoreClient(...) for a Store copy
 *   log,
 * })
 */
export function createUpdateService({ currentVersion, managedBy = null, store = null, log } = {}) {
  const storeManaged = managedBy === 'store';
  const current = () => normalizeVersion(String(currentVersion ?? ''));
  let phase = 'idle';
  let latest = null; // { version }: a version newer than this copy

  const snapshot = () => ({
    phase,
    currentVersion: current() || String(currentVersion ?? ''),
    latest: latest ? { version: latest.version } : null,
    // 'store': the Microsoft Store delivers this copy's updates, and is who the check asks.
    managedBy: storeManaged ? 'store' : null,
  });

  async function check() {
    if (phase === 'checking') throw updateError('busy');
    latest = null;
    if (!storeManaged) {
      phase = 'unavailable';
      return snapshot();
    }
    if (!store) {
      phase = 'store';
      return snapshot();
    }
    phase = 'checking';
    const cur = current();
    log?.info('update check started', { currentVersion: cur || currentVersion, source: 'microsoft-store' });
    try {
      if (!cur) throw updateError('malformed_version');
      const found = await store.latest();
      if (compareVersions(found.version, cur) > 0) {
        latest = { version: found.version };
        phase = 'available';
        log?.info('update available in the Microsoft Store', { currentVersion: cur, latestVersion: found.version });
      } else {
        phase = 'up-to-date';
        log?.info('update not available', { currentVersion: cur, storeVersion: found.version });
      }
    } catch (err) {
      phase = 'store';
      log?.warn('the Microsoft Store could not be asked for its version', {
        code: err?.code,
        detail: err?.detail || err?.message,
      });
    }
    return snapshot();
  }

  return { snapshot, check };
}
