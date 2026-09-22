// App identity and on-disk config locations.
//
// Canonical dir is ~/.config/k8dashboard. Older installs used ~/.config/k8sight
// or ~/.config/k8s-manager — those are still read so tokens, Azure auth and
// settings survive the rename. New files are always written to the canonical dir.
import fs from 'fs';
import os from 'os';
import path from 'path';

export const APP_NAME = 'k8dashboard';
export const CONFIG_DIR = path.join(os.homedir(), '.config', APP_NAME);
const LEGACY_DIRS = ['k8sight', 'k8s-manager'].map((n) => path.join(os.homedir(), '.config', n));

export function envToken() {
  return String(process.env.K8DASHBOARD_TOKEN || process.env.K8SIGHT_TOKEN || '').trim();
}

export function nodeBin() {
  return process.env.K8DASHBOARD_NODE_BIN || process.env.K8SIGHT_NODE_BIN || process.execPath;
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

export function isMcpSource(req) {
  return req.get('X-K8dashboard-Source') === 'mcp' || req.get('X-K8sight-Source') === 'mcp';
}
