// ============================================================
// Built-in image scanning with a bundled `trivy` — so the Security Center works
// without installing the Trivy Operator in the user's cluster.
//
// We enumerate the images the cluster is actually running (from Pods) and run
// `trivy image --format json` on each with the app's own binary, then aggregate
// into the exact shape the /api/security/vulnerabilities endpoint returns, so
// the frontend's Overview / Images views render identically to operator data.
//
// trivy is resolved from TRIVY_BIN, then a bundled path next to the app, then
// PATH. The Docker image installs it; desktop builds ship it in resources. When
// none is present it is downloaded from the pinned GitHub release and verified
// against that release's SHA256 checksums before it is installed.
//
// Scans are tracked per kube context (getScanState(context)), so a scan of one
// cluster never blocks another; cancelAll() kills every running trivy child.
// ============================================================
import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Where we cache an auto-downloaded trivy so users need neither the operator
// nor a manual install.
const CACHE_DIR = path.join(os.homedir(), '.config', 'k8s-manager', 'bin');
const CACHED_TRIVY = path.join(CACHE_DIR, process.platform === 'win32' ? 'trivy.exe' : 'trivy');
// Pinned release for auto-download. TRIVY_VERSION=x.y.z pins another one;
// TRIVY_VERSION=latest opts in to asking GitHub for the newest release.
export const TRIVY_VERSION = '0.74.0';
const GITHUB_RELEASES = 'https://github.com/aquasecurity/trivy/releases/download';

// ---- child processes -------------------------------------------------------
// Every trivy/tar child is tracked so cancelAll() can reap them on shutdown.
const children = new Set();
function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { windowsHide: true, ...opts }, (err, stdout, stderr) => {
      children.delete(child);
      if (err) { err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
    });
    children.add(child);
  });
}

// Persist each cluster's last scan so results survive an app restart. One JSON
// file per context under the app config dir (same place as other app state).
const SCAN_DIR = path.join(os.homedir(), '.config', 'k8s-manager', 'security-scans');
const scanFile = (context) => path.join(SCAN_DIR, `${String(context || 'default').replace(/[^a-zA-Z0-9_.@+-]/g, '_').slice(0, 200)}.json`);
const scanCache = new Map(); // file → { mtimeMs, size, data } — parsed once per on-disk version

export function persistScan(context, result) {
  try {
    fs.mkdirSync(SCAN_DIR, { recursive: true });
    const file = scanFile(context);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(result), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
    scanCache.delete(file);
  } catch { /* non-fatal */ }
}
// Async (this sits on a polled route) and cached by file mtime+size so the
// JSON is parsed once per on-disk version, not once per poll.
export async function loadScan(context) {
  const file = scanFile(context);
  try {
    const st = await fsp.stat(file);
    const hit = scanCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data;
    const data = JSON.parse(await fsp.readFile(file, 'utf-8'));
    scanCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data });
    return data;
  } catch { return null; }
}

// Candidate locations for a shipped binary: TRIVY_BIN, the repo/dev ./bin
// (populated by scripts/fetch-trivy.mjs), and the packaged app's resources/bin
// (electron-builder extraResources). Platform-aware name (trivy.exe on Windows).
const TRIVY_NAME = process.platform === 'win32' ? 'trivy.exe' : 'trivy';
const BUNDLED = [
  process.env.TRIVY_BIN,
  path.join(__dirname, 'bin', TRIVY_NAME),
  process.resourcesPath && path.join(process.resourcesPath, 'bin', TRIVY_NAME),
].filter(Boolean);

let _bin = null;
export function trivyBin() {
  if (_bin) return _bin;
  for (const p of BUNDLED) { try { if (fs.existsSync(p)) { _bin = p; return _bin; } } catch { /* ignore */ } }
  _bin = 'trivy'; // fall back to PATH
  return _bin;
}

async function versionOf(bin) {
  try {
    const { stdout } = await run(bin, ['--version'], { timeout: 8000 });
    return (stdout.match(/Version:\s*([^\s]+)/) || [])[1] || stdout.split('\n')[0].trim();
  } catch { return null; }
}

// The GitHub release asset name for this OS/arch (null if unsupported).
function assetName(version) {
  const o = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }[process.platform];
  const a = { x64: '64bit', arm64: 'ARM64', arm: 'ARM' }[process.arch];
  if (!o || !a) return null;
  return `trivy_${version}_${o}-${a}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
}
// Can we fetch trivy ourselves? (mac/linux; Windows install is manual for now.)
export function trivyInstallable() { return process.platform !== 'win32' && !!assetName('x'); }

export async function trivyAvailable() {
  // present on PATH / bundled?
  let v = await versionOf(trivyBin());
  if (!v && fs.existsSync(CACHED_TRIVY)) { _bin = CACHED_TRIVY; v = await versionOf(CACHED_TRIVY); }
  return { available: !!v, version: v || undefined, installable: trivyInstallable() };
}

// Opt-in only (TRIVY_VERSION=latest): ask GitHub for the newest release.
async function latestVersion() {
  try {
    const r = await fetch('https://api.github.com/repos/aquasecurity/trivy/releases/latest', { headers: { 'user-agent': 'k8sight' }, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const v = String(j.tag_name || '').replace(/^v/, '');
    return /^\d+\.\d+\.\d+$/.test(v) ? v : TRIVY_VERSION;
  } catch { return TRIVY_VERSION; }
}
async function installVersion() {
  const want = String(process.env.TRIVY_VERSION || '').trim().replace(/^v/, '');
  if (!want) return TRIVY_VERSION;
  if (want.toLowerCase() === 'latest') return latestVersion();
  if (!/^\d+\.\d+\.\d+$/.test(want)) throw new Error(`TRIVY_VERSION "${want}" is not a valid version (x.y.z or "latest").`);
  return want;
}

// The release's checksum manifest: `<sha256>  <asset>` per line.
async function expectedSha256(version, asset) {
  const r = await fetch(`${GITHUB_RELEASES}/v${version}/trivy_${version}_checksums.txt`, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Downloading the trivy ${version} checksum list failed (${r.status}).`);
  for (const line of (await r.text()).split('\n')) {
    const [sum, name] = line.trim().split(/\s+/);
    if (name === asset && /^[a-f0-9]{64}$/i.test(sum || '')) return sum.toLowerCase();
  }
  throw new Error(`No checksum for ${asset} in the trivy ${version} release — refusing to install.`);
}

// Return a usable trivy path — downloading, verifying + caching the binary if
// none exists. Fails closed: nothing is written to disk unless the archive's
// SHA256 matches the release's checksum list.
export async function ensureTrivy(onPhase) {
  if ((await trivyAvailable()).available) return trivyBin();
  if (fs.existsSync(CACHED_TRIVY)) { _bin = CACHED_TRIVY; return CACHED_TRIVY; }
  if (!trivyInstallable()) throw new Error('trivy is not available — install it and add it to PATH.');
  onPhase?.('preparing');
  const version = await installVersion();
  const asset = assetName(version);
  if (!asset) throw new Error(`No trivy build for ${process.platform}/${process.arch}.`);
  const [expected, r] = await Promise.all([
    expectedSha256(version, asset),
    fetch(`${GITHUB_RELEASES}/v${version}/${asset}`, { redirect: 'follow', signal: AbortSignal.timeout(180000) }),
  ]);
  if (!r.ok) throw new Error(`Downloading trivy failed (${r.status}).`);
  const archive = Buffer.from(await r.arrayBuffer());
  const actual = crypto.createHash('sha256').update(archive).digest('hex');
  if (actual !== expected) throw new Error(`trivy ${version} download failed its integrity check (sha256 ${actual} != ${expected}) — refusing to install.`);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const tgz = path.join(CACHE_DIR, asset);
  fs.writeFileSync(tgz, archive);
  try {
    await run('tar', ['-xzf', tgz, '-C', CACHE_DIR, 'trivy'], { timeout: 60000 });
    fs.chmodSync(CACHED_TRIVY, 0o755);
  } finally {
    try { fs.unlinkSync(tgz); } catch { /* ignore */ }
  }
  _bin = CACHED_TRIVY;
  return CACHED_TRIVY;
}

// Every unique running image → the pods using it.
export function listClusterImages(pods, namespace) {
  const byImage = new Map();
  for (const p of pods) {
    const ns = p.metadata?.namespace || '';
    if (namespace && namespace !== 'all' && ns !== namespace) continue;
    const owner = p.metadata?.ownerReferences?.[0];
    const spec = p.spec || {};
    const containers = [...(spec.containers || []), ...(spec.initContainers || []), ...(spec.ephemeralContainers || [])];
    for (const c of containers) {
      const image = c.image;
      if (!image) continue;
      if (!byImage.has(image)) byImage.set(image, []);
      byImage.get(image).push({ kind: owner?.kind || 'Pod', name: owner?.name || p.metadata?.name, namespace: ns, container: c.name });
    }
  }
  return byImage;
}

const SEV = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];
const emptySummary = () => ({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 });

// An image reference comes from Pod specs (cluster data). It is passed after
// `--` so it can never be read as a flag, and anything that isn't a plausible
// single-token reference is rejected outright.
export function assertImageRef(image) {
  if (typeof image !== 'string' || !image || image.length > 4096) throw new Error('Invalid image reference');
  if (/^-/.test(image)) throw new Error(`Invalid image reference "${image.slice(0, 40)}" (starts with "-")`);
  // eslint-disable-next-line no-control-regex -- intentionally matching control characters
  if (/[\s\x00-\x1f\x7f]/.test(image)) throw new Error('Invalid image reference (contains whitespace or control characters)');
  return image;
}

// Scan one image → { os, summary, vulnerabilities[] } in our model's shape.
export async function scanImage(image) {
  assertImageRef(image);
  const args = ['image', '--quiet', '--format', 'json', '--scanners', 'vuln,secret', '--timeout', '5m', '--', image];
  const { stdout } = await run(trivyBin(), args, { timeout: 6 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  const rep = JSON.parse(stdout || '{}');
  const summary = emptySummary();
  const seen = new Set();
  const vulnerabilities = [];
  const secretsList = [];
  for (const r of (rep.Results || [])) {
    for (const v of (r.Vulnerabilities || [])) {
      const sev = (v.Severity || 'UNKNOWN').toUpperCase();
      if (summary[sev] != null) summary[sev]++;
      const key = `${v.VulnerabilityID}|${v.PkgName}|${v.InstalledVersion}`;
      if (seen.has(key)) continue; seen.add(key);
      vulnerabilities.push({
        id: v.VulnerabilityID, severity: sev, pkg: v.PkgName || '',
        installedVersion: v.InstalledVersion || '', fixedVersion: v.FixedVersion || '',
        title: v.Title || v.Description || '', link: v.PrimaryURL || (v.References || [])[0] || '',
        score: v.CVSS?.nvd?.V3Score || v.CVSS?.redhat?.V3Score,
      });
    }
    for (const s of (r.Secrets || [])) {
      secretsList.push({ ruleID: s.RuleID || '', severity: (s.Severity || 'UNKNOWN').toUpperCase(), title: s.Title || '', target: r.Target || '', line: s.StartLine });
    }
  }
  const cfg = rep.Metadata?.ImageConfig || {};
  const platform = [cfg.os, cfg.architecture].filter(Boolean).join('/');
  const os = rep.Metadata?.OS ? `${rep.Metadata.OS.Family || ''} ${rep.Metadata.OS.Name || ''}`.trim() : '';
  return { os, platform, summary, secrets: secretsList.length, secretsList, vulnerabilities };
}

// ---- scan state, one per kube context --------------------------------------
// Progress + result live on the context's state object so GET /api/security/scan
// can report it; a scan of cluster A never blocks starting one on cluster B.
const idleState = (context) => ({
  running: false, done: false, phase: 'idle', context: context ?? null, total: 0, scanned: 0, startedAt: null, finishedAt: null,
  error: null, images: null, summary: emptySummary(), results: { ok: 0, vulnerable: 0 }, cancelled: false,
});
export const scanStates = new Map(); // context → state
export function getScanState(context) {
  const key = context ?? null;
  if (!scanStates.has(key)) scanStates.set(key, idleState(key));
  return scanStates.get(key);
}
// Compatibility alias: the state of the most recently started scan (live
// binding). Prefer getScanState(context).
export let scanState = getScanState(null);

function resetScan(state) {
  Object.assign(state, {
    running: true, done: false, phase: 'preparing', total: 0, scanned: 0, startedAt: new Date().toISOString(),
    finishedAt: null, error: null, images: null, summary: emptySummary(), results: { ok: 0, vulnerable: 0 }, cancelled: false,
  });
}

const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, UNKNOWN: 4 };
const sevTotal = (s) => SEV.reduce((n, k) => n + (s[k] || 0), 0);

// Kick off a scan of every running image. Downloads trivy first if needed.
// Returns immediately; progress + result live on the returned state object.
export async function startScan(byImage, context) {
  const state = getScanState(context);
  if (state.running) return state;
  resetScan(state);
  scanState = state;
  (async () => {
    try {
      await ensureTrivy((p) => { state.phase = p; }); // may download the binary
      state.phase = 'scanning';
      const entries = [...byImage.entries()];
      state.total = entries.length;
      const out = [];
      const total = emptySummary();
      let cursor = 0;
      const worker = async () => {
        while (cursor < entries.length && !state.cancelled) {
          const [image, workloads] = entries[cursor++];
          let scan;
          try { scan = await scanImage(image); }
          catch (e) { scan = { os: '', summary: emptySummary(), vulnerabilities: [], error: (e.message || 'scan failed').split('\n')[0] }; }
          if (state.cancelled) break;
          for (const k of SEV) total[k] += scan.summary[k];
          scan.vulnerabilities.sort((a, b) => order[a.severity] - order[b.severity] || (b.score || 0) - (a.score || 0));
          const tag = (image.split(':')[1] || '').split('@')[0];
          out.push({
            image, repository: image.split(':')[0], tag, digest: (image.split('@')[1] || ''),
            os: scan.os, platform: scan.platform || '', namespace: workloads[0]?.namespace || '',
            status: scan.error ? 'Failed' : 'Scanned', scanner: 'Trivy (built-in)', scannedAt: new Date().toISOString(),
            summary: scan.summary, criticalCount: scan.summary.CRITICAL, workloads, vulnerabilities: scan.vulnerabilities,
            secrets: scan.secrets || 0, secretsList: scan.secretsList || [], scanError: scan.error,
          });
          state.scanned++;
          // Stream partial results so the UI fills in while the scan runs.
          out.sort((a, b) => (b.summary.CRITICAL - a.summary.CRITICAL) || (b.summary.HIGH - a.summary.HIGH));
          const partialVuln = out.filter((g) => sevTotal(g.summary) > 0).length;
          state.images = out.slice();
          state.summary = { ...total };
          state.results = { vulnerable: partialVuln, ok: out.length - partialVuln };
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, entries.length || 1) }, worker));
      if (state.cancelled) {
        Object.assign(state, { running: false, done: true, phase: 'cancelled', error: 'Scan cancelled', finishedAt: new Date().toISOString() });
        return;
      }
      out.sort((a, b) => (b.summary.CRITICAL - a.summary.CRITICAL) || (b.summary.HIGH - a.summary.HIGH));
      const vulnerable = out.filter((g) => sevTotal(g.summary) > 0).length;
      const finishedAt = new Date().toISOString();
      const results = { vulnerable, ok: out.length - vulnerable };
      Object.assign(state, { running: false, done: true, phase: 'done', finishedAt, images: out, summary: total, results });
      // Persist so the results are there after an app restart.
      persistScan(context, { images: out, summary: total, results, scanned: state.scanned, total: state.total, finishedAt });
    } catch (e) {
      Object.assign(state, { running: false, done: true, phase: state.cancelled ? 'cancelled' : 'error', error: (e.message || 'scan failed').split('\n')[0], finishedAt: new Date().toISOString() });
    }
  })();
  return state;
}

// Stop every running scan and kill its trivy children (server shutdown).
export function cancelAll() {
  for (const state of scanStates.values()) if (state.running) state.cancelled = true;
  for (const child of children) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  children.clear();
}
