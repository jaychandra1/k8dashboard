// Which release asset fits this machine.
//
// Asset names come from electron-builder's `artifactName` in package.json:
//
//   KubePilot-<os>[-<arch>].<ext>        e.g. KubePilot-windows.exe
//                                              KubePilot-windows-arm64.exe
//                                              KubePilot-linux-x64.AppImage
//
//   <os>   windows | macos | linux   (aliases: win; mac, darwin, osx)
//   <arch> x64 | arm64               (aliases: amd64, x86_64; aarch64)
//   <ext>  exe (NSIS installer) | dmg | AppImage | deb
//
// An optional version segment is accepted too (KubePilot-1.4.0-macos-arm64.dmg).
// Today's release workflow builds ONE architecture per OS and names it without
// an arch suffix (see UNSUFFIXED_ARCH); a suffixed name always wins, so adding
// e.g. a Windows ARM64 build later only needs `-arm64` in its file name.
import { updateError } from './errors.mjs';

/** The architecture of the unsuffixed build of each OS (.github/workflows/release.yml). */
export const UNSUFFIXED_ARCH = { windows: 'x64', macos: 'arm64', linux: 'x64' };

/** File extension of each install kind. */
export const KIND_EXT = { nsis: 'exe', dmg: 'dmg', appimage: 'AppImage', deb: 'deb' };
const KIND_OS = { nsis: 'windows', dmg: 'macos', appimage: 'linux', deb: 'linux' };
const DEFAULT_KIND = { windows: 'nsis', macos: 'dmg', linux: 'appimage' };

const OS_TOKENS = { windows: ['windows', 'win'], macos: ['macos', 'mac', 'darwin', 'osx'], linux: ['linux'] };
const ARCH_TOKENS = { x64: ['x64', 'amd64', 'x86_64'], arm64: ['arm64', 'aarch64'] };
const OS_LABEL = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
const ARCH_LABEL = { x64: 'x64', arm64: 'ARM64' };
const KIND_LABEL = { nsis: 'installer', dmg: 'disk image', appimage: 'AppImage', deb: '.deb package' };

const NODE_OS = { win32: 'windows', darwin: 'macos', linux: 'linux' };

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The machine to update: { os, arch, installKind, label } from Node's
 * platform/arch and the install kind the desktop host detected (on Linux the
 * kind — AppImage or .deb — decides which asset fits). `os`/`arch` are null
 * for platforms KubePilot doesn't ship for.
 */
export function detectTarget({ platform = process.platform, arch = process.arch, installKind } = {}) {
  const os = NODE_OS[platform] || null;
  const a = arch === 'x64' || arch === 'arm64' ? arch : null;
  const kind = installKind && KIND_OS[installKind] === os ? installKind : os ? DEFAULT_KIND[os] : null;
  return {
    os,
    arch: a,
    installKind: kind,
    label: `${OS_LABEL[os] || platform} ${ARCH_LABEL[a] || arch}`,
  };
}

/**
 * Parse a release asset name → { os, arch (null = unsuffixed), ext, version }.
 * Null for anything that isn't a KubePilot installer (checksums, SBOM, blockmaps…).
 */
export function parseAssetName(name, product = 'KubePilot') {
  if (typeof name !== 'string') return null;
  const osAlt = Object.values(OS_TOKENS).flat().join('|');
  const archAlt = Object.values(ARCH_TOKENS).flat().map(escapeRe).join('|');
  const extAlt = Object.values(KIND_EXT).join('|');
  const re = new RegExp(`^${escapeRe(product)}(?:[-_]v?(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?))?[-_](${osAlt})(?:[-_](${archAlt}))?\\.(${extAlt})$`, 'i');
  const m = name.match(re);
  if (!m) return null;
  const [, version, osTok, archTok, ext] = m;
  const os = Object.keys(OS_TOKENS).find((k) => OS_TOKENS[k].includes(osTok.toLowerCase()));
  const arch = archTok ? Object.keys(ARCH_TOKENS).find((k) => ARCH_TOKENS[k].includes(archTok.toLowerCase())) : null;
  return { os, arch, ext: ext.toLowerCase(), version: version || null };
}

/**
 * Pick the one asset that installs on `target` ({ os, arch, installKind }).
 * Throws no_asset_for_os when the release has nothing for this OS / install
 * kind, and no_asset_for_arch when it has, but not for this architecture.
 * Never falls back to "the first .exe".
 */
export function selectAsset(assets, target, { product = 'KubePilot', version } = {}) {
  const { os, arch, installKind } = target || {};
  const label = `${OS_LABEL[os] || 'this system'} ${ARCH_LABEL[arch] || ''}`.trim();
  const shown = version ? `KubePilot v${version}` : 'A new KubePilot version';
  if (!os || !installKind || KIND_OS[installKind] !== os) {
    throw updateError('no_asset_for_os', `${shown} is available, but KubePilot does not publish an installer for ${label}.`);
  }
  const ext = KIND_EXT[installKind].toLowerCase();
  const forOs = (Array.isArray(assets) ? assets : [])
    .map((asset) => ({ asset, parsed: parseAssetName(asset?.name, product) }))
    .filter(({ parsed }) => parsed && parsed.os === os && parsed.ext === ext)
    // An asset carrying a version must carry this release's version.
    .filter(({ parsed }) => !parsed.version || !version || parsed.version === version);
  if (!forOs.length) {
    throw updateError('no_asset_for_os', `${shown} is available, but a ${KIND_LABEL[installKind]} for ${OS_LABEL[os]} could not be found in the release.`, { detail: `no *.${ext} asset for ${os}` });
  }
  const exact = forOs.find(({ parsed }) => parsed.arch === arch);
  const implied = forOs.find(({ parsed }) => parsed.arch === null && UNSUFFIXED_ARCH[os] === arch);
  const hit = exact || implied;
  if (!hit || !arch) {
    throw updateError('no_asset_for_arch', `${shown} is available, but an installer for ${label} could not be found.`, { detail: `assets for ${os}: ${forOs.map(({ asset }) => asset.name).join(', ')}` });
  }
  return hit.asset;
}
