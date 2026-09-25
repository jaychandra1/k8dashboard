#!/usr/bin/env node
// Native AKS (Azure AD) authentication-token generator — a self-contained
// replacement for `kubelogin get-token --login azurecli` that needs NO `az` and
// NO `kubelogin`, only Node.
//
// AKS kubeconfig entries written by the app's CLI-free Azure import exec this
// file, so both @kubernetes/client-node and kubectl can authenticate to an
// AAD-enabled AKS cluster without any Azure CLI. It works like kubelogin's
// azurecli mode — take the signed-in user's refresh token and exchange it for an
// access token scoped to the cluster's AAD server app — except the refresh token
// comes from the app's own browser sign-in, persisted at ~/.config/kubepilot/
// azure-auth.json, instead of az's MSAL cache.
//
// Usage: node azure-token.js --server-id <aad-server-app-id> [--tenant <tenant>]
//   (packaged desktop app: `KubePilot --token-helper azure --server-id …`,
//   which electron/main.cjs routes to run() below)
import fs from 'fs';
import { pathToFileURL } from 'url';
import { CONFIG_DIR, configFile, findConfigFile } from './lib/paths.mjs';
import { seal, unseal, isSealed, PURPOSE } from './lib/secret-store.mjs';

const AAD = 'https://login.microsoftonline.com';
// Azure CLI's well-known first-party public client — the same one the app's
// browser sign-in uses; it permits cross-resource refresh-token redemption.
const CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';
const AUTH_FILE = findConfigFile('azure-auth.json');
const AUTH_FILE_WRITE = configFile('azure-auth.json');

const argOf = (argv, name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };

// Persist the rotated refresh token atomically (AAD returns a fresh one on each
// redemption; keeping the store current avoids premature re-sign-in). Sealed by
// lib/secret-store.mjs when a key is available (Windows desktop app).
export function saveRefreshToken(store, refreshToken) {
  try {
    const next = { ...store, refreshToken: seal(refreshToken, PURPOSE.azureRefreshToken) };
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${AUTH_FILE_WRITE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(tmp, AUTH_FILE_WRITE);
    try { fs.chmodSync(AUTH_FILE_WRITE, 0o600); } catch { /* best effort */ }
  } catch { /* non-fatal: the current token still authenticated this call */ }
}

/**
 * The auth store and its refresh token in plaintext (sealed or legacy value).
 * Throws the user-facing "sign in" errors when there is no usable session.
 */
export function readStoredRefreshToken() {
  let store;
  try { store = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8')); }
  catch { throw new Error('Not signed in to Azure — open KubePilot and sign in to Azure.'); }
  const refreshToken = unseal(store?.refreshToken, PURPOSE.azureRefreshToken);
  if (!refreshToken) {
    throw new Error(isSealed(store?.refreshToken)
      ? 'The saved Azure sign-in can\'t be opened on this machine or account — sign in to Azure in KubePilot again.'
      : 'No Azure session — sign in to Azure in KubePilot.');
  }
  return { store, refreshToken };
}

/**
 * Produce the ExecCredential JSON for `argv` (the flags after the script name).
 * Never touches stdout/stderr and never exits; throws on failure.
 */
export async function run(argv = []) {
  const serverId = argOf(argv, 'server-id');
  if (!serverId) throw new Error('--server-id is required');

  const { store, refreshToken } = readStoredRefreshToken();

  const tenant = argOf(argv, 'tenant') || store.tenant || 'organizations';
  const r = await fetch(`${AAD}/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
      scope: `${serverId}/.default openid profile offline_access`,
    }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) {
    throw new Error((t.error_description || t.error || `token request failed (${r.status})`).split('\n')[0]);
  }
  if (t.refresh_token && t.refresh_token !== refreshToken) saveRefreshToken(store, t.refresh_token);

  // Report the token's real lifetime so clients refresh in time (60s margin).
  const expirationTimestamp = new Date(Date.now() + ((t.expires_in || 3600) - 60) * 1000).toISOString();
  return JSON.stringify({
    kind: 'ExecCredential',
    apiVersion: 'client.authentication.k8s.io/v1beta1',
    spec: {},
    status: { expirationTimestamp, token: t.access_token },
  });
}

async function main() {
  process.stdout.write(await run(process.argv.slice(2)));
}

// CLI entry only when executed directly (`node azure-token.js …`), not when
// imported by electron/main.cjs or a test.
const sameFile = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && sameFile(import.meta.url, pathToFileURL(process.argv[1]).href)) {
  main().catch((e) => { process.stderr.write(`azure-token: ${e.message}\n`); process.exit(1); });
}
