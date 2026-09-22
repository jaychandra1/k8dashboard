// electron-builder afterPack hook.
//
// Two jobs, in this order (fuses change the binary, so they must land before
// any signature is computed):
//
//   1. Electron fuses (all platforms) — hard-disable the Node.js escape hatches
//      that an attacker on the machine could otherwise use to run arbitrary
//      code *as the trusted k8dashboard binary*:
//        RunAsNode=false                          ELECTRON_RUN_AS_NODE is ignored
//        EnableNodeOptionsEnvironmentVariable=false  NODE_OPTIONS is ignored
//        EnableNodeCliInspectArguments=false      --inspect/--inspect-brk ignored
//        EnableCookieEncryption=true              session cookies are encrypted at rest
//        OnlyLoadAppFromAsar=false                asar is OFF for this app (see
//                                                 electron/main.cjs: the ESM
//                                                 backend can't be loaded from
//                                                 inside an archive), so this
//                                                 fuse cannot be enabled. The
//                                                 app directory is protected by
//                                                 the OS install location and,
//                                                 on macOS, the bundle signature.
//
//   2. macOS ad-hoc signing. We have no Apple Developer ID certificate, so
//      electron-builder ships the app UNSIGNED (mac.identity is null). On Apple
//      Silicon an unsigned (or signature-invalidated) bundle is killed by
//      Gatekeeper on launch and reported as "damaged" / "malware". An *ad-hoc*
//      signature (`codesign -s -`) has no certificate but produces a valid,
//      self-consistent signature that macOS will run locally. We sign every
//      nested Mach-O first (frameworks, helpers, dylibs, the unpacked `.node`
//      addon) and then the app bundle, inside-out, as codesign requires.
//
// To move to Developer ID signing + notarization later: set `mac.identity`,
// flip `mac.hardenedRuntime` to true (build/entitlements.mac.plist is already
// wired up in package.json) and delete step 2 — electron-builder then signs and
// notarizes the fused binary itself.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName; // darwin | win32 | linux
  const appName = context.packager.appInfo.productFilename;

  await applyFuses(context, platform, appName);
  if (platform === 'darwin') adHocSign(path.join(context.appOutDir, `${appName}.app`));
};

// ---------------------------------------------------------------------------
// 1. Fuses
// ---------------------------------------------------------------------------
function electronBinaryPath(context, platform, appName) {
  const exe = context.packager.executableName || appName;
  switch (platform) {
    case 'darwin':
      return path.join(context.appOutDir, `${appName}.app`);
    case 'win32':
      return path.join(context.appOutDir, `${exe}.exe`);
    default:
      return path.join(context.appOutDir, exe);
  }
}

async function applyFuses(context, platform, appName) {
  const binary = electronBinaryPath(context, platform, appName);
  if (!fs.existsSync(binary)) {
    throw new Error(`afterPack: cannot find Electron binary to fuse at ${binary}`);
  }
  console.log(`  • flipping Electron fuses  binary=${binary}`);
  await flipFuses(binary, {
    version: FuseVersion.V1,
    // Re-sign the macOS bundle ad-hoc after patching so codesign stays valid
    // even before our own signing pass below.
    resetAdHocDarwinSignature: platform === 'darwin',
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    // asar is disabled in package.json (build.asar=false) — see header comment.
    [FuseV1Options.OnlyLoadAppFromAsar]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
  });
  console.log('  • fuses applied');
}

// ---------------------------------------------------------------------------
// 2. macOS ad-hoc signature
// ---------------------------------------------------------------------------
function adHocSign(appPath) {
  // Plain ad-hoc signature, WITHOUT the hardened runtime. Hardened runtime
  // turns on library validation, which requires every loaded library to share
  // the main executable's Team ID or be an Apple platform binary. Ad-hoc
  // signatures carry no Team ID, so a hardened helper refuses to load the
  // ad-hoc Electron Framework ("mapping process and mapped file have different
  // Team IDs", dyld). An ad-hoc build can never be notarized anyway, so the
  // hardened runtime buys us nothing here — omit it and the app runs.
  const sign = (target) => {
    execFileSync('codesign', ['--force', '--timestamp=none', '--sign', '-', target], { stdio: 'inherit' });
  };

  console.log(`  • ad-hoc signing (no Developer ID)  app=${appPath}`);
  try {
    // Nested Mach-O first: frameworks, dylibs, unpacked .node addons and the
    // bundled `node`/helper executables. codesign requires inside-out order,
    // so sign the deepest paths before their containers.
    for (const p of collectNested(path.join(appPath, 'Contents'))) sign(p);
    sign(appPath);

    // Verify the signature is valid before a DMG is built around it.
    execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
      stdio: 'inherit',
    });
    console.log('  • ad-hoc signature verified');
  } catch (err) {
    console.warn(`  ! ad-hoc signing failed: ${err.message}`);
    console.warn('  ! the app may be blocked by Gatekeeper on launch.');
  }
}

// Depth-first walk of the .app collecting signable Mach-O paths, deepest first.
// Covers *.framework, *.dylib, *.node and any executable files in MacOS/.
function collectNested(root) {
  const hits = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        walk(full);
        if (/\.(framework|app)$/.test(e.name)) hits.push(full); // container after its contents
      } else if (/\.(dylib|node|so)$/.test(e.name)) {
        hits.push(full);
      } else if (isMachOExecutable(full)) {
        hits.push(full);
      }
    }
  };
  walk(root);
  return hits;
}

// A file is a signable executable if it starts with a Mach-O magic number.
function isMachOExecutable(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    const magic = buf.readUInt32BE(0);
    // MH_MAGIC/CIGAM (32/64) and fat-binary magics.
    return [0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic);
  } catch {
    return false;
  }
}
