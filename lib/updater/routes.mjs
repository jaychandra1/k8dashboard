// HTTP API for Help → Show Release Notes / Check for Updates. Same bearer
// token and origin guard as the rest of /api; MCP clients are refused.
//
//   GET  /api/app/release-notes      what's new in each version (shipped with the app; no request)
//   GET  /api/app/update             the last check's result
//   POST /api/app/update/check       Windows: compare the running version with the Microsoft
//                                    Store's. Other copies have no store to ask.
//
// K8Board downloads and installs no update itself, so there is nothing else here.
import os from 'node:os';
import { updateError, UpdateError } from './errors.mjs';
import { createStoreClient } from './store.mjs';
import { createUpdateService } from './service.mjs';
import { readReleaseNotes } from '../release-notes.mjs';
import { envFrom } from '../paths.mjs';

/**
 * Build the update service and the release notes reader for this backend.
 * The desktop host says who delivers this copy's updates through env
 * (electron/main.cjs backendEnv):
 *   K8BOARD_INSTALL_MANAGED_BY   store — the Microsoft Store (every Windows copy), which is
 *                                who Check for Updates asks. Absent: nobody is asked.
 */
export function createUpdates({ rootDir, version, log, env = process.env, fetchImpl = globalThis.fetch }) {
  const managedBy = envFrom(env, 'INSTALL_MANAGED_BY') === 'store' ? 'store' : null;
  const userAgent = `K8Board/${version} (${os.platform()}; ${os.arch()})`;
  const service = createUpdateService({
    currentVersion: version,
    managedBy,
    store: managedBy === 'store' ? createStoreClient({ fetchImpl, userAgent }) : null,
    log,
  });
  // Help → Show Release Notes: the notes shipped with this copy, for its version.
  const notes = () => readReleaseNotes({ rootDir, currentVersion: version, log });
  return { service, notes };
}

export function registerUpdateRoutes(app, { service, notes, isMcpSource }) {
  const noMcp = (req, res, next) =>
    isMcpSource?.(req)
      ? res
          .status(403)
          .json({ error: 'K8Board updates are not available to MCP clients', code: 'forbidden' })
      : next();
  const send = (res, fn) =>
    Promise.resolve()
      .then(fn)
      .then((body) => res.json(body))
      .catch((err) => {
        const e = err instanceof UpdateError ? err : updateError('failed', undefined, { cause: err });
        res.status(Number.isInteger(e.status) ? e.status : 500).json({ error: e.message, code: e.code });
      });

  app.get('/api/app/release-notes', noMcp, (req, res) => send(res, () => notes()));
  app.get('/api/app/update', noMcp, (req, res) => res.json({ state: service.snapshot() }));
  app.post('/api/app/update/check', noMcp, (req, res) =>
    send(res, async () => ({ state: await service.check() }))
  );
}
