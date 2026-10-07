// Desktop side of the updater (see lib/updater/). The backend downloads and
// verifies an update, then asks the main process — the only process that may
// install software or restart the app — over the utilityProcess message port:
//   { kpUpdate: 1, id, type: 'install', payload: { file, sha256, version, kind, when } }
//   { kpUpdate: 1, id, type: 'relaunch' }
// Every install request is re-checked here: the installer must be a regular
// file inside the update directory and still have the SHA-256 the backend
// verified. KUBEPILOT_UPDATE_DRY_RUN=1 logs what would run and runs nothing.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const MARKER = 'pending-install.json';
const log = (...a) => console.log('[KubePilot] update:', ...a);

/**
 * Download directory, in the OS cache location (as electron-updater uses):
 *   Windows  %LOCALAPPDATA%\kubepilot-updater
 *   macOS    ~/Library/Caches/kubepilot-updater
 *   Linux    $XDG_CACHE_HOME/kubepilot-updater (~/.cache/…)
 */
function defaultUpdateDir(
  name = 'kubepilot',
  { platform = process.platform, env = process.env, home = os.homedir() } = {}
) {
  // The target platform's path rules, not the host's (so this is right — and
  // testable — whichever OS evaluates it).
  const p = platform === 'win32' ? path.win32 : path.posix;
  let base;
  if (platform === 'win32')
    base =
      env.LOCALAPPDATA && p.isAbsolute(env.LOCALAPPDATA)
        ? env.LOCALAPPDATA
        : p.join(home, 'AppData', 'Local');
  else if (platform === 'darwin') base = p.join(home, 'Library', 'Caches');
  else
    base =
      env.XDG_CACHE_HOME && p.isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : p.join(home, '.cache');
  return p.join(base, `${name}-updater`);
}

function sha256FileSync(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

const sameDigest = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  /^[0-9a-f]{64}$/.test(a) &&
  /^[0-9a-f]{64}$/.test(b) &&
  crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

class HostError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * createUpdateHost({ app, rootDir, platform, isPackaged, execPath, dir, dryRun, env, spawnImpl })
 * Resolves once the installation kind is known (lib/updater/install.mjs).
 */
async function createUpdateHost({
  app,
  rootDir,
  platform = process.platform,
  isPackaged = app.isPackaged,
  execPath = process.execPath,
  dir = defaultUpdateDir(),
  dryRun = process.env.KUBEPILOT_UPDATE_DRY_RUN === '1',
  env = process.env,
  spawnImpl = spawn,
  existsSync = fs.existsSync,
} = {}) {
  const lib = await import(pathToFileURL(path.join(rootDir, 'lib', 'updater', 'install.mjs')).href);
  const install = lib.detectInstall({ platform, isPackaged, execPath, env, existsSync });
  log(
    install.kind ? `install kind ${install.kind}` : `self-update unavailable (${install.reason})`,
    dryRun ? '(dry run)' : ''
  );
  let scheduled = null; // Windows "Later": { file, sha256, version, args }
  let launched = false;

  const insideDir = (file) => {
    const rel = path.relative(dir, path.resolve(file));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  };

  async function checkFile({ file, sha256 }) {
    if (typeof file !== 'string' || !insideDir(file))
      throw new HostError(
        'install_failed',
        'The update installer is not where KubePilot downloaded it, so it was not run.'
      );
    let st;
    try {
      st = fs.lstatSync(file);
    } catch {
      st = null;
    }
    if (!st || !st.isFile())
      throw new HostError('install_failed', 'The downloaded update is missing. Please try again.');
    const actual = await sha256File(file);
    if (!sameDigest(actual, String(sha256 || '').toLowerCase())) {
      log(`refused ${path.basename(file)}: SHA-256 changed since verification`);
      fs.rmSync(file, { force: true });
      throw new HostError(
        'verification_failed',
        'The downloaded KubePilot update could not be verified and will not be installed.'
      );
    }
  }

  function writeMarker(version) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, MARKER),
      JSON.stringify({ version, from: app.getVersion(), at: new Date().toISOString() })
    );
  }
  const clearMarker = () => fs.rmSync(path.join(dir, MARKER), { force: true });

  async function handleInstall(p) {
    if (!install.kind) throw new HostError('unsupported', install.message);
    if (p.kind !== install.kind)
      throw new HostError(
        'install_failed',
        'The downloaded update is for a different kind of KubePilot installation.'
      );
    await checkFile(p);

    if (install.kind === 'nsis') {
      if (p.when === 'on-quit') {
        scheduled = {
          file: p.file,
          sha256: p.sha256,
          version: p.version,
          args: lib.nsisArgs({ relaunch: false }),
        };
        log(`v${p.version} will install when KubePilot quits`);
        return { scheduled: true, dryRun };
      }
      if (dryRun) {
        log(
          `dry run: would start ${path.basename(p.file)} ${lib.nsisArgs({ relaunch: true }).join(' ')} and quit`
        );
        return { restarting: false, dryRun: true };
      }
      writeMarker(p.version);
      try {
        await lib.launchNsisInstaller(p.file, { relaunch: true, spawnImpl });
      } catch (err) {
        clearMarker();
        throw err;
      }
      launched = true;
      log(`installer for v${p.version} started; quitting so it can replace KubePilot`);
      setTimeout(() => app.quit(), 300); // let the reply reach the backend first
      return { restarting: true };
    }

    if (dryRun) {
      log(`dry run: would install ${path.basename(p.file)} (${install.kind}) over ${install.appPath}`);
      return { installed: false, dryRun: true };
    }
    log(`installing v${p.version} (${install.kind}) over ${install.appPath}`);
    await lib.installInPlace({
      kind: install.kind,
      file: p.file,
      appPath: install.appPath,
      workDir: path.join(dir, 'work'),
      log,
    });
    fs.rmSync(p.file, { force: true });
    log(`v${p.version} installed; restart to finish`);
    return { installed: true };
  }

  function handleRelaunch() {
    if (dryRun) {
      log('dry run: would relaunch');
      return { dryRun: true };
    }
    log('restart requested');
    // An AppImage runs from a temporary mount that disappears on exit: start the (new) AppImage file itself.
    if (install.kind === 'appimage') app.relaunch({ execPath: install.appPath, args: [] });
    else app.relaunch();
    setTimeout(() => app.quit(), 200);
    return { restarting: true };
  }

  return {
    install,
    dir,

    /** Handle one message from the backend; `reply` posts the answer back. */
    async onMessage(msg, reply) {
      if (!msg || msg.kpUpdate !== 1 || typeof msg.id !== 'number') return;
      try {
        const result =
          msg.type === 'install'
            ? await handleInstall(msg.payload || {})
            : msg.type === 'relaunch'
              ? handleRelaunch()
              : (() => {
                  throw new HostError(
                    'install_failed',
                    `Unknown update request ${String(msg.type).slice(0, 40)}`
                  );
                })();
        reply({ kpUpdate: 1, id: msg.id, ok: true, result });
      } catch (err) {
        const code =
          err && typeof err.code === 'string' && /^[a-z_]+$/.test(err.code) ? err.code : 'install_failed';
        log(`${msg.type} failed: ${code}${err && err.detail ? ` (${err.detail})` : ''}`);
        reply({
          kpUpdate: 1,
          id: msg.id,
          ok: false,
          error: {
            code: msg.type === 'relaunch' && code === 'install_failed' ? 'restart_failed' : code,
            message: err && err.message,
          },
        });
      }
    },

    /** Windows "Later": start the installer (no relaunch) as KubePilot quits. */
    onWillQuit() {
      if (!scheduled || launched) return;
      launched = true;
      const { file, sha256, version, args } = scheduled;
      try {
        if (!insideDir(file) || !sameDigest(sha256FileSync(file), sha256)) {
          log('scheduled installer changed since verification; not installing');
          return;
        }
        if (dryRun) {
          log(`dry run: would start ${path.basename(file)} ${args.join(' ')} on quit`);
          return;
        }
        writeMarker(version);
        const child = spawnImpl(file, args, { detached: true, stdio: 'ignore' });
        child.on('error', (e) => log(`installer did not start: ${e.code || e.message}`));
        child.unref();
        log(`installer for v${version} started on quit`);
      } catch (err) {
        clearMarker();
        log(`installer did not start: ${err.message}`);
      }
    },

    /**
     * After a Windows update: did the installer bring us to the new version?
     * Returns { status: 'installed' | 'failed', version, from } once, or null.
     */
    previousResult() {
      let marker;
      try {
        marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'));
      } catch {
        return null;
      }
      clearMarker();
      if (!marker || typeof marker.version !== 'string') return null;
      const current = app.getVersion();
      const ok = current.replace(/^v/, '') === marker.version.replace(/^v/, '');
      if (ok) fs.rmSync(path.join(dir, 'pending'), { recursive: true, force: true });
      log(
        ok
          ? `now running v${current} (updated from v${marker.from})`
          : `update to v${marker.version} did not complete (still v${current})`
      );
      return {
        status: ok ? 'installed' : 'failed',
        version: marker.version,
        from: typeof marker.from === 'string' ? marker.from : current,
      };
    },
  };
}

module.exports = { createUpdateHost, defaultUpdateDir, MARKER };
