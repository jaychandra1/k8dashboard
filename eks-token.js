#!/usr/bin/env node
// Native EKS authentication-token generator — a drop-in replacement for
// `aws eks get-token` that needs NO aws CLI, only Node + the bundled AWS SDK.
//
// The kubeconfig entries written by the AWS EKS integration exec this file, so
// both @kubernetes/client-node and kubectl can authenticate to EKS without the
// aws binary or a local credential chain beyond what the SDK reads itself.
//
// Usage: node eks-token.js --cluster <name> --region <region> [--profile <p>]
//   (packaged desktop app: `KubePilot --token-helper eks --cluster …`, which
//   electron/main.cjs routes to run() below)
// Credentials come from --profile (SDK fromNodeProviderChain honours ~/.aws and
// assume-role) or, if no profile, the ambient AWS_* environment variables.
import { pathToFileURL } from 'url';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

const argOf = (argv, name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };

/**
 * Produce the ExecCredential JSON for `argv` (the flags after the script name).
 * Pure: never touches stdout/stderr and never exits; throws on failure.
 */
export async function run(argv = []) {
  const clusterName = argOf(argv, 'cluster');
  const region = argOf(argv, 'region') || process.env.AWS_REGION || 'us-east-1';
  const profile = argOf(argv, 'profile');
  if (!clusterName) throw new Error('--cluster is required');

  const credentials = await fromNodeProviderChain(profile ? { profile } : {})();

  const signer = new SignatureV4({ service: 'sts', region, credentials, sha256: Sha256, applyChecksum: false });
  const request = new HttpRequest({
    method: 'GET', protocol: 'https:', hostname: `sts.${region}.amazonaws.com`, path: '/',
    query: { Action: 'GetCallerIdentity', Version: '2011-06-15' },
    headers: { host: `sts.${region}.amazonaws.com`, 'x-k8s-aws-id': clusterName },
  });
  const signed = await signer.presign(request, { expiresIn: 60 });
  const qs = new URLSearchParams(signed.query).toString();
  const url = `https://${signed.hostname}${signed.path}?${qs}`;
  const token = 'k8s-aws-v1.' + Buffer.from(url).toString('base64url').replace(/=+$/, '');

  // Report the token's own lifetime as the expiry so clients refresh in time.
  const expirationTimestamp = new Date(Date.now() + 55 * 1000).toISOString();
  return JSON.stringify({
    kind: 'ExecCredential',
    apiVersion: 'client.authentication.k8s.io/v1beta1',
    spec: {},
    status: { expirationTimestamp, token },
  });
}

async function main() {
  process.stdout.write(await run(process.argv.slice(2)));
}

// CLI entry only when executed directly (`node eks-token.js …`), not when
// imported by electron/main.cjs or a test.
const sameFile = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && sameFile(import.meta.url, pathToFileURL(process.argv[1]).href)) {
  main().catch((e) => { process.stderr.write(`eks-token: ${e.message}\n`); process.exit(1); });
}
