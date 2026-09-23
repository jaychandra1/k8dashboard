// Self-heal the kubeconfig `user.exec` entries this app writes.
//
// Older builds wrote `command: <Electron exe>, env: ELECTRON_RUN_AS_NODE=1`.
// The packaged app now ships with the RunAsNode fuse off, so that exe starts
// as a GUI, defers to the running instance and prints nothing — the cluster
// can never authenticate. Entries also go stale when the app is renamed,
// moved or a dev checkout is deleted. On every kubeconfig load we rewrite the
// entries that belong to us and can no longer work with the shape
// lib/paths.mjs `execEntry()` produces for the current runtime; every other
// user (aws eks get-token, kubelogin, certificates, …) is left untouched.
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { execEntry, TOKEN_HELPER_FLAG } from './paths.mjs';
import { logger } from './logger.mjs';

const HELPER_FILE_RE = /^(eks-token|azure-token)\.js$/i;
const APP_BASENAME_RE = /^(k8sight|k8dashboard|kubepilot)(\.exe)?$/i;
const RESOURCES_APP_RE = /resources[\\/]app/i;

const basename = (p) => String(p).split(/[\\/]/).pop();
const isFlag = (a) => typeof a === 'string' && a.startsWith('--');

/** Does `args` reference one of our helper files or the CLI flag? */
function referencesHelper(args) {
  return args.some((a) => typeof a === 'string' && (a === TOKEN_HELPER_FLAG || HELPER_FILE_RE.test(basename(a))));
}

/** Is `command` the app binary itself (any of its historical names or a packaged path)? */
function isAppCommand(command) {
  return APP_BASENAME_RE.test(basename(command)) || RESOURCES_APP_RE.test(command);
}

// Absolute paths must exist; bare names are looked up on PATH (with PATHEXT on Windows).
function commandExists(command) {
  if (!command || typeof command !== 'string') return false;
  if (/[\\/]/.test(command)) return fs.existsSync(command);
  const exts = process.platform === 'win32' ? ['', ...String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const dir of String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) if (fs.existsSync(path.join(dir, command + ext))) return true;
  }
  return false;
}

/**
 * Work out which helper an old entry ran and the flags it passed.
 * `null` when the entry isn't one of ours or the flags are unusable.
 */
export function deriveHelperInvocation(exec) {
  const args = Array.isArray(exec?.args) ? exec.args.filter((a) => typeof a === 'string') : [];
  let helper = null;
  const rest = [...args];
  const flagAt = rest.indexOf(TOKEN_HELPER_FLAG);
  if (flagAt >= 0) {
    helper = rest[flagAt + 1] || null;
    rest.splice(flagAt, 2);
  } else {
    const file = args.find((a) => HELPER_FILE_RE.test(basename(a)));
    if (file) helper = /^eks/i.test(basename(file)) ? 'eks' : 'azure';
  }
  if (helper !== 'eks' && helper !== 'azure') return null;
  // Keep everything from the first `--flag` onward (drops the helper file path).
  const first = rest.findIndex(isFlag);
  const flags = first >= 0 ? rest.slice(first) : [];
  const required = helper === 'eks' ? '--cluster' : '--server-id';
  if (!flags.includes(required)) return null;
  return { helper, args: flags };
}

/**
 * Decide whether `exec` is an entry we own that has to be rewritten.
 * Returns a reason string, or null to leave it alone.
 */
export function staleReason(exec, opts = {}) {
  if (!exec || typeof exec !== 'object') return null;
  const command = typeof exec.command === 'string' ? exec.command : '';
  const args = Array.isArray(exec.args) ? exec.args : [];
  const ours = referencesHelper(args) || (command && isAppCommand(command));
  if (!ours) return null;
  const exists = opts.commandExists ? opts.commandExists(command) : commandExists(command);
  if (!exists) return 'command-missing';
  const legacyEnv = Array.isArray(exec.env) && exec.env.some((e) => e?.name === 'ELECTRON_RUN_AS_NODE');
  if (legacyEnv && isAppCommand(command)) return 'legacy-run-as-node';
  return null;
}

// <file>.kubepilot-backup-YYYYMMDD-HHmmss, once per file per process (same
// naming as the import path in aws-eks.js / server.js).
const backedUp = new Set();
function backupOnce(file) {
  if (backedUp.has(file)) return;
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const backup = `${file}.kubepilot-backup-${ts}`;
  fs.copyFileSync(file, backup);
  try { fs.chmodSync(backup, 0o600); } catch { /* best effort */ }
  backedUp.add(file);
}

function writePrivate(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

/**
 * Repair stale helper exec entries in the kubeconfig at `file`.
 * Never throws; returns `{ repaired: string[] }` (user names rewritten).
 *
 * `opts.execEntryOpts` is forwarded to execEntry() ({ electron, execPath });
 * `opts.commandExists` and `opts.log` are test seams.
 */
export function repairExecEntries(file, opts = {}) {
  const log = opts.log || logger;
  const repaired = [];
  let doc;
  try {
    if (!file || !fs.existsSync(file)) return { repaired };
    doc = yaml.load(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    log.warn('kubeconfig repair skipped: file does not parse', { path: file, err: err?.message });
    return { repaired };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.users)) return { repaired };

  for (const u of doc.users) {
    const exec = u?.user?.exec;
    const reason = staleReason(exec, opts);
    if (!reason) continue;
    const inv = deriveHelperInvocation(exec);
    if (!inv) {
      log.warn('kubeconfig exec entry looks stale but its flags could not be recovered; leaving it', { path: file, user: u.name });
      continue;
    }
    const next = execEntry(inv.helper, inv.args, opts.execEntryOpts);
    // Idempotence: if the entry is already exactly what we would write (same
    // command and args, no legacy env), there is nothing to repair.
    const legacyEnv = Array.isArray(exec.env) && exec.env.some((e) => e?.name === 'ELECTRON_RUN_AS_NODE');
    if (!legacyEnv && exec.command === next.command && JSON.stringify(exec.args) === JSON.stringify(next.args)) continue;
    u.user.exec = {
      apiVersion: 'client.authentication.k8s.io/v1beta1',
      command: next.command,
      args: next.args,
      ...(next.env ? { env: next.env } : {}),
      interactiveMode: 'Never',
      provideClusterInfo: false,
    };
    repaired.push(u.name);
    log.info('repaired kubeconfig auth helper entry', {
      path: file, user: u.name, helper: inv.helper, reason, oldCommand: exec.command, command: next.command,
    });
  }

  if (repaired.length) {
    try {
      backupOnce(file);
      writePrivate(file, yaml.dump(doc, { noRefs: true, lineWidth: -1 }));
    } catch (err) {
      log.warn('kubeconfig repair could not write the file', { path: file, err: err?.message });
      return { repaired: [] };
    }
  }
  return { repaired };
}
