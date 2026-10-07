// HTTP API for Help → Show Release Notes / Check for Updates. Same bearer
// token and origin guard as the rest of /api; MCP clients are refused (an
// agent never downloads or installs KubePilot updates).
//
//   GET  /api/app/release-notes      latest stable release (notes)
//   GET  /api/app/update             current update state (polled while busy)
//   POST /api/app/update/check       compare the running version with GitHub's latest
//   POST /api/app/update/download    download + verify (+ install in place on macOS/Linux)
//   POST /api/app/update/cancel      cancel the download
//   POST /api/app/update/install     { when: 'now' | 'on-quit' } — Windows: run the installer
//   POST /api/app/update/restart     relaunch after an in-place install
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { updateError, UpdateError } from './errors.mjs';
import { createReleaseService, releaseRepository } from './github.mjs';
import { createHostBridge } from './host.mjs';
import { detectTarget } from './platform.mjs';
import { createUpdateService } from './service.mjs';

const INSTALL_KINDS = new Set(['nsis', 'dmg', 'appimage', 'deb']);

/**
 * Build the release + update services for this backend. The desktop host
 * describes the installation through env (electron/main.cjs backendEnv):
 *   KUBEPILOT_INSTALL_KIND         nsis | dmg | appimage | deb (absent → can't install)
 *   KUBEPILOT_INSTALL_UNAVAILABLE  why not, in words, when it can't
 *   KUBEPILOT_UPDATE_DIR           download directory (the OS cache dir)
 */
export function createUpdates({
  rootDir,
  version,
  log,
  env = process.env,
  parentPort = process.parentPort,
  fetchImpl = globalThis.fetch,
}) {
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  } catch {
    /* defaults below */
  }
  const product = pkg.productName || pkg.build?.productName || 'KubePilot';
  const userAgent = `${product}/${version} (${os.platform()}; ${os.arch()})`;
  const kind = INSTALL_KINDS.has(env.KUBEPILOT_INSTALL_KIND) ? env.KUBEPILOT_INSTALL_KIND : null;
  const releases = createReleaseService({ repo: releaseRepository({ pkg, env }), userAgent, fetchImpl, log });
  const service = createUpdateService({
    currentVersion: version,
    releases,
    target: detectTarget({ installKind: kind }),
    install: { kind, message: env.KUBEPILOT_INSTALL_UNAVAILABLE || undefined },
    updateDir: env.KUBEPILOT_UPDATE_DIR || null,
    host: createHostBridge(parentPort),
    log,
    product,
    fetchImpl,
    userAgent,
  });
  return { releases, service };
}

export function registerUpdateRoutes(app, { service, isMcpSource }) {
  const noMcp = (req, res, next) =>
    isMcpSource?.(req)
      ? res
          .status(403)
          .json({ error: 'KubePilot updates are not available to MCP clients', code: 'forbidden' })
      : next();
  const send = (res, fn) =>
    Promise.resolve()
      .then(fn)
      .then((body) => res.json(body))
      .catch((err) => {
        const e = err instanceof UpdateError ? err : updateError('install_failed', undefined, { cause: err });
        res.status(e.status).json({ error: e.message, code: e.code, retryable: e.retryable });
      });

  app.get('/api/app/release-notes', noMcp, (req, res) =>
    send(res, async () => ({ release: await service.releaseNotes({ fresh: req.query.fresh === '1' }) }))
  );
  app.get('/api/app/update', noMcp, (req, res) => res.json({ state: service.snapshot() }));
  app.post('/api/app/update/check', noMcp, (req, res) =>
    send(res, async () => ({ state: await service.check({ fresh: true }) }))
  );
  app.post('/api/app/update/download', noMcp, (req, res) =>
    send(res, () => ({ state: service.startDownload() }))
  );
  app.post('/api/app/update/cancel', noMcp, (req, res) => send(res, () => ({ state: service.cancel() })));
  app.post('/api/app/update/install', noMcp, (req, res) =>
    send(res, async () => ({
      state: await service.install({ when: req.body?.when === 'on-quit' ? 'on-quit' : 'now' }),
    }))
  );
  app.post('/api/app/update/restart', noMcp, (req, res) =>
    send(res, async () => ({ state: await service.restart() }))
  );
}
