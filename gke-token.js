#!/usr/bin/env node
// GKE authentication-token helper — stands in for gke-gcloud-auth-plugin, so
// the only Google tool needed is the gcloud CLI the user signed in with.
//
// The kubeconfig entries written by the Google GKE integration exec this file,
// so both @kubernetes/client-node and kubectl can authenticate to GKE.
//
// Usage: node gke-token.js [--account <google account>]
//   (packaged desktop app: `K8Board --token-helper gke …`, which
//   electron/main.cjs routes to run() below; the entry's other flags,
//   --project / --location / --cluster, only say which cluster it is for)
// The token is gcloud's own short-lived access token for that account; it is
// printed for kubectl and never stored.
import { isMainModule } from './lib/paths.mjs';
import { gcloudAccessToken } from './lib/gcloud.mjs';

const argOf = (argv, name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };

/**
 * Produce the ExecCredential JSON for `argv` (the flags after the script name).
 * Pure: never touches stdout/stderr and never exits; throws on failure.
 */
export async function run(argv = [], { token = gcloudAccessToken, now = Date.now } = {}) {
  const got = await token({ account: argOf(argv, 'account') || null });
  // Clients refresh at this time: a minute before the token really ends, and
  // never in the past.
  const expirationTimestamp = new Date(Math.max(now() + 30_000, got.expiresAt - 60_000)).toISOString();
  return JSON.stringify({
    kind: 'ExecCredential',
    apiVersion: 'client.authentication.k8s.io/v1beta1',
    spec: {},
    status: { expirationTimestamp, token: got.token },
  });
}

async function main() {
  process.stdout.write(await run(process.argv.slice(2)));
}

// CLI entry only when executed directly (`node gke-token.js …`), not when
// imported by electron/main.cjs or a test.
if (isMainModule(import.meta.url)) {
  main().catch((e) => { process.stderr.write(`gke-token: ${e.message}\n`); process.exit(1); });
}
