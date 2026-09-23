// App identity and on-disk config locations.
//
// Canonical dir is ~/.config/kubepilot. Older installs used ~/.config/k8dashboard,
// ~/.config/k8sight or ~/.config/k8s-manager — those are still read so tokens,
// Azure auth and settings survive the rename. New files are always written to
// the canonical dir.
//
// This module is the ONLY place (besides electron/main.cjs, which forwards the
// environment to the backend) that knows the legacy K8DASHBOARD_* / K8SIGHT_*
// environment variable names. Everything else reads KUBEPILOT_* through the
// helpers below.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

export const APP_NAME = 'kubepilot';
// Project / app root (the directory that holds eks-token.js, azure-token.js).
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_DIR = path.join(os.homedir(), '.config', APP_NAME);
const LEGACY_DIRS = ['k8dashboard', 'k8sight', 'k8s-manager'].map((n) =>
  path.join(os.homedir(), '.config', n)
);

// Legacy env-var prefixes, newest first. `envVar('TOKEN')` reads KUBEPILOT_TOKEN,
// then K8DASHBOARD_TOKEN, then K8SIGHT_TOKEN.
const ENV_PREFIXES = ['KUBEPILOT_', 'K8DASHBOARD_', 'K8SIGHT_'];

/** Raw value of KUBEPILOT_<name>, falling back to the legacy prefixes. '' when unset. */
export function envVar(name) {
  for (const prefix of ENV_PREFIXES) {
    const v = process.env[prefix + name];
    if (v !== undefined && v !== '') return String(v);
  }
  return '';
}

/** Boolean flag: KUBEPILOT_<name> (or legacy) set to 1/true/yes/on. */
export function envFlag(name) {
  return ['1', 'true', 'yes', 'on'].includes(envVar(name).trim().toLowerCase());
}

export function envToken() {
  return envVar('TOKEN').trim();
}

export function nodeBin() {
  return envVar('NODE_BIN') || process.execPath;
}

// ---- kubeconfig exec entries ----------------------------------------------
// The kubeconfig users written by the EKS / AKS imports authenticate through
// the bundled ESM helpers. How they are launched depends on the runtime:
//
//   • Inside Electron (main *or* the server utility process — both have
//     process.versions.electron) the packaged binary is re-entered with the
//     explicit CLI flag `--token-helper <eks|azure> …`. electron/main.cjs
//     handles that flag before any GUI code runs. ELECTRON_RUN_AS_NODE cannot
//     be used: the RunAsNode fuse is off in packaged builds, so the exe would
//     start as a GUI, defer to the running instance and print nothing.
//   • Under plain Node (dev, Docker) the helper file is run with node itself
//     (KUBEPILOT_NODE_BIN / legacy names override the binary).
//
// This is the ONLY place that decides that shape; lib/kubeconfig-repair.mjs
// rewrites stale entries with it.
const HELPER_FILES = Object.freeze({ eks: 'eks-token.js', azure: 'azure-token.js' });
export const TOKEN_HELPER_FLAG = '--token-helper';

/** Absolute path of a helper file ('eks' | 'azure'). */
export function helperFile(helper) {
  const file = HELPER_FILES[helper];
  if (!file) throw new Error(`unknown token helper "${helper}" (expected eks or azure)`);
  return path.join(ROOT_DIR, file);
}

/**
 * `{ command, args }` for a kubeconfig `user.exec` running `helper` with `args`.
 * `opts.electron` / `opts.execPath` override runtime detection (tests).
 */
export function execEntry(helper, args = [], opts = {}) {
  const file = helperFile(helper);
  const electron = opts.electron ?? Boolean(process.versions?.electron);
  if (electron) {
    // KUBEPILOT_APP_EXEC is set by electron/main.cjs for the utility process,
    // whose own process.execPath may be a helper binary on some platforms.
    const command = opts.execPath || envVar('APP_EXEC') || process.execPath;
    return { command, args: [TOKEN_HELPER_FLAG, helper, ...args] };
  }
  return { command: opts.execPath || nodeBin(), args: [file, ...args] };
}

/** Path for a new file under the canonical config dir. */
export function configFile(...segments) {
  return path.join(CONFIG_DIR, ...segments);
}

/** Existing file: canonical first, then legacy dirs. Falls back to the canonical path for writes. */
export function findConfigFile(...segments) {
  const current = configFile(...segments);
  if (fs.existsSync(current)) return current;
  for (const dir of LEGACY_DIRS) {
    const p = path.join(dir, ...segments);
    if (fs.existsSync(p)) return p;
  }
  return current;
}

// MCP self-HTTP calls are tagged with X-KubePilot-Source: mcp. The header names
// of the previous product names are still honoured so an old mcp-stdio.js
// bridge talking to a new server keeps hitting the write gate.
const MCP_SOURCE_HEADERS = ['X-KubePilot-Source', 'X-K8dashboard-Source', 'X-K8sight-Source'];

export function isMcpSource(req) {
  return MCP_SOURCE_HEADERS.some((h) => req.get(h) === 'mcp');
}
