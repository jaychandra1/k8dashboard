// Installing a downloaded, verified update — run by the Electron main process
// (electron/update-host.cjs), never by the backend, and only with an injected
// runner in tests (no test ever installs anything).
//
// How each package KubePilot ships is updated (package.json "build"):
//   nsis      Windows NSIS installer (electron-builder, oneClick, per-user → no
//             elevation). It replaces files of the running app, so it runs
//             AFTER KubePilot quits: `--updated /S [--force-run]` — the same
//             switches electron-builder's own updater (NsisUpdater) passes to
//             this installer; --force-run starts KubePilot again only once the
//             install has succeeded.
//   dmg       macOS: the .app from the disk image is copied next to the
//             installed bundle and swapped in by rename, keeping the old bundle
//             until the swap succeeded (rolled back otherwise). Admin rights
//             are asked for (osascript) only when the folder isn't writable.
//   appimage  Linux AppImage: the new file replaces $APPIMAGE by an atomic rename.
//   deb       Linux .deb (installed under /opt): `pkexec dpkg -i` — polkit asks
//             for administrator rights; dpkg rolls back a failed unpack.
import { execFile, spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { updateError, UpdateError } from './errors.mjs';

/** Silent-update switches for the electron-builder NSIS installer (see NsisUpdater). */
export const NSIS_UPDATE_ARGS = ['--updated', '/S'];
export const nsisArgs = ({ relaunch }) =>
  relaunch ? [...NSIS_UPDATE_ARGS, '--force-run'] : [...NSIS_UPDATE_ARGS];

/** /Applications/KubePilot.app from …/KubePilot.app/Contents/MacOS/KubePilot. */
export function macBundlePath(execPath) {
  const m = String(execPath || '').match(/^(\/.+?\.app)\/Contents\/MacOS\/[^/]+$/);
  return m ? m[1] : null;
}

/**
 * How this copy of KubePilot was installed, and therefore how it updates:
 * { kind: 'nsis'|'dmg'|'appimage'|'deb', appPath } or { kind: null, reason, message }.
 */
export function detectInstall({
  platform = process.platform,
  isPackaged,
  execPath,
  env = process.env,
  existsSync = fsSync.existsSync,
  productName = 'KubePilot',
  packageName = 'kubepilot',
} = {}) {
  const no = (reason, message) => ({ kind: null, reason, message });
  if (!isPackaged)
    return no('development', "This is a development build of KubePilot, so it can't install updates.");
  if (platform === 'win32') {
    const dir = path.win32.dirname(execPath);
    if (existsSync(path.win32.join(dir, `Uninstall ${productName}.exe`)))
      return { kind: 'nsis', appPath: dir };
    return no(
      'portable',
      "This copy of KubePilot wasn't installed with the KubePilot installer, so it can't update itself."
    );
  }
  if (platform === 'darwin') {
    const bundle = macBundlePath(execPath);
    if (!bundle)
      return no('unsupported', "KubePilot can't find its application bundle, so it can't update itself.");
    if (bundle.startsWith('/Volumes/'))
      return no(
        'dmg',
        'KubePilot is running from its disk image. Drag it to your Applications folder, open it from there, then check for updates again.'
      );
    if (bundle.includes('/AppTranslocation/'))
      return no(
        'translocated',
        'macOS is running KubePilot from a temporary location. Move KubePilot to your Applications folder, open it from there, then check for updates again.'
      );
    return { kind: 'dmg', appPath: bundle };
  }
  if (platform === 'linux') {
    const appImage = env.APPIMAGE;
    if (typeof appImage === 'string' && path.posix.isAbsolute(appImage) && existsSync(appImage))
      return { kind: 'appimage', appPath: appImage };
    if (String(execPath).startsWith('/opt/') && existsSync(`/var/lib/dpkg/info/${packageName}.list`))
      return { kind: 'deb', appPath: path.posix.dirname(execPath) };
    return no(
      'unsupported',
      "This copy of KubePilot can't update itself. Install updates from the release page or with your package manager."
    );
  }
  return no('unsupported', "KubePilot can't update itself on this system.");
}

/** Promise-based execFile; rejects with { code, stderr }. */
export function runFile(cmd, args, { timeout = 10 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || '');
        reject(err);
      } else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const tail = (s, n = 400) =>
  String(s || '')
    .trim()
    .slice(-n);
const writable = (fsImpl, dir) =>
  fsImpl.access(dir, fsSync.constants.W_OK).then(
    () => true,
    () => false
  );

/**
 * Start the NSIS installer detached so it outlives KubePilot. Resolves once
 * the process has started; rejects with installer_launch_failed.
 */
export function launchNsisInstaller(file, { relaunch = true, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(file, nsisArgs({ relaunch }), { detached: true, stdio: 'ignore' });
    } catch (err) {
      reject(
        updateError('installer_launch_failed', undefined, { detail: err?.code || err?.message, cause: err })
      );
      return;
    }
    child.once('error', (err) =>
      reject(
        updateError('installer_launch_failed', undefined, { detail: err?.code || err?.message, cause: err })
      )
    );
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

// --- macOS ----------------------------------------------------------------
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const appleScriptString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The privileged copy-and-swap, as one /bin/sh command line (paths quoted). */
export function macSwapScript({ src, stage, appPath, backup }) {
  return [
    `/bin/rm -rf ${shq(stage)}`,
    `/usr/bin/ditto ${shq(src)} ${shq(stage)}`,
    `/bin/mv ${shq(appPath)} ${shq(backup)}`,
    `{ /bin/mv ${shq(stage)} ${shq(appPath)} || { /bin/mv ${shq(backup)} ${shq(appPath)}; exit 1; }; }`,
    `/bin/rm -rf ${shq(backup)}`,
  ].join(' && ');
}

export async function installDmg({ file, appPath, workDir, run = runFile, fsImpl = fs, log } = {}) {
  if (!appPath || !appPath.endsWith('.app') || !path.posix.isAbsolute(appPath))
    throw updateError('install_failed', undefined, { detail: `bad bundle path ${appPath}` });
  await fsImpl.mkdir(workDir, { recursive: true });
  const mount = await fsImpl.mkdtemp(path.posix.join(workDir, 'mnt-'));
  let attached = false;
  try {
    try {
      await run('/usr/bin/hdiutil', [
        'attach',
        '-nobrowse',
        '-noautoopen',
        '-readonly',
        '-mountpoint',
        mount,
        file,
      ]);
      attached = true;
    } catch (err) {
      throw updateError('install_failed', undefined, {
        detail: `hdiutil attach: ${tail(err.stderr || err.message)}`,
        cause: err,
      });
    }
    const appName = (await fsImpl.readdir(mount)).find((e) => e.endsWith('.app'));
    if (!appName) throw updateError('install_failed', undefined, { detail: 'disk image has no .app' });
    const src = path.posix.join(mount, appName);
    const parent = path.posix.dirname(appPath);
    const base = path.posix.basename(appPath);
    const stage = path.posix.join(parent, `.${base}.update-${process.pid}`);
    const backup = path.posix.join(parent, `.${base}.previous-${process.pid}`);

    if (await writable(fsImpl, parent)) {
      await fsImpl.rm(stage, { recursive: true, force: true });
      try {
        await run('/usr/bin/ditto', [src, stage]);
      } catch (err) {
        await fsImpl.rm(stage, { recursive: true, force: true }).catch(() => {});
        throw updateError('install_failed', undefined, {
          detail: `ditto: ${tail(err.stderr || err.message)}`,
          cause: err,
        });
      }
      // Swap by rename (same volume → atomic); the running app keeps its open files.
      try {
        await fsImpl.rename(appPath, backup);
      } catch (err) {
        await fsImpl.rm(stage, { recursive: true, force: true }).catch(() => {});
        throw updateError('install_failed', undefined, { detail: `move aside: ${err.message}`, cause: err });
      }
      try {
        await fsImpl.rename(stage, appPath);
      } catch (err) {
        await fsImpl.rename(backup, appPath).catch((e) => log?.(`rollback failed: ${e.message}`));
        await fsImpl.rm(stage, { recursive: true, force: true }).catch(() => {});
        throw updateError('install_failed', undefined, { detail: `swap: ${err.message}`, cause: err });
      }
      await fsImpl.rm(backup, { recursive: true, force: true }).catch(() => {});
    } else {
      // e.g. /Applications for a standard (non-admin) user: macOS asks for an
      // administrator for this one step.
      log?.('application folder not writable; asking for administrator rights');
      const script = macSwapScript({ src, stage, appPath, backup });
      try {
        await run('/usr/bin/osascript', [
          '-e',
          `do shell script ${appleScriptString(script)} with administrator privileges`,
        ]);
      } catch (err) {
        if (/-128|User cancel/i.test(`${err.stderr} ${err.message}`)) {
          throw updateError(
            'permission_denied',
            'Administrator permission was not given, so the update was not installed. Your existing KubePilot installation has not been modified.'
          );
        }
        throw updateError('install_failed', undefined, {
          detail: `privileged swap: ${tail(err.stderr || err.message)}`,
          cause: err,
        });
      }
    }
  } finally {
    if (attached) {
      await run('/usr/bin/hdiutil', ['detach', mount, '-quiet']).catch(() =>
        run('/usr/bin/hdiutil', ['detach', mount, '-force', '-quiet']).catch(() => {})
      );
    }
    await fsImpl.rm(mount, { recursive: true, force: true }).catch(() => {});
  }
}

// --- Linux ----------------------------------------------------------------
export async function installAppImage({ file, appPath, fsImpl = fs } = {}) {
  const parent = path.posix.dirname(appPath);
  if (!(await writable(fsImpl, parent))) {
    throw updateError(
      'permission_denied',
      `KubePilot can't replace ${appPath} because its folder isn't writable. Your existing KubePilot installation has not been modified.`
    );
  }
  const stage = path.posix.join(parent, `.${path.posix.basename(appPath)}.update-${process.pid}`);
  try {
    await fsImpl.copyFile(file, stage);
    await fsImpl.chmod(stage, 0o755);
    await fsImpl.rename(stage, appPath); // atomic; the running AppImage stays mounted
  } catch (err) {
    await fsImpl.rm(stage, { force: true }).catch(() => {});
    throw updateError('install_failed', undefined, { detail: err.message, cause: err });
  }
}

export const PKEXEC = '/usr/bin/pkexec';
export const DPKG = '/usr/bin/dpkg';

export async function installDeb({ file, run = runFile, existsSync = fsSync.existsSync } = {}) {
  if (!existsSync(PKEXEC)) {
    throw updateError(
      'permission_denied',
      "Installing the .deb update needs administrator rights through pkexec (polkit), which isn't available. Your existing KubePilot installation has not been modified."
    );
  }
  try {
    await run(PKEXEC, [DPKG, '-i', file], { timeout: 15 * 60_000 });
  } catch (err) {
    // pkexec: 126 = the authentication dialog was dismissed, 127 = not authorised.
    if (err.code === 126 || err.code === 127) {
      throw updateError(
        'permission_denied',
        'Administrator permission was not given, so the update was not installed. Your existing KubePilot installation has not been modified.'
      );
    }
    throw updateError('install_failed', undefined, {
      detail: `dpkg: ${tail(err.stderr || err.message)}`,
      cause: err,
    });
  }
}

/** Install a verified update in place (macOS / Linux). */
export async function installInPlace({ kind, file, appPath, workDir, run, fsImpl, existsSync, log }) {
  try {
    if (kind === 'dmg') return await installDmg({ file, appPath, workDir, run, fsImpl, log });
    if (kind === 'appimage') return await installAppImage({ file, appPath, fsImpl });
    if (kind === 'deb') return await installDeb({ file, run, existsSync });
  } catch (err) {
    if (err instanceof UpdateError) throw err;
    throw updateError('install_failed', undefined, { detail: err?.message || String(err), cause: err });
  }
  throw updateError('unsupported', `KubePilot can't install a "${kind}" update in place.`);
}
