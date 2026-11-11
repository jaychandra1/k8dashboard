// The Google Cloud CLI (gcloud) as K8Board's Google sign-in: K8Board has no
// Google sign-in of its own (that needs an OAuth app Google has reviewed), so
// it uses the account the user signed in to gcloud with. It only ever asks
// gcloud who is signed in and for a short-lived access token; the token is
// used for Google's APIs and never stored or logged.
//
//   gcloudStatus()         → { installed, accounts: [{ account, active }], account }
//   gcloudAccessToken()    → { token, expiresAt }   (config-helper, as kubectl's gcp auth did)
//   startGcloudLogin()     → the `gcloud auth login` child (it opens the browser)
import { spawnBin, collectChild, commandExists } from './kubectl.mjs';

// An account as gcloud prints it: a user's email or a service account's.
export const ACCOUNT_RE = /^[A-Za-z0-9._%+-]{1,128}@[A-Za-z0-9.-]{1,190}$/;
export const isAccount = (v) => typeof v === 'string' && ACCOUNT_RE.test(v);

const firstLine = (s) => String(s || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';

/** Why gcloud could not help, in words the UI can show. */
export class GcloudError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GcloudError';
    this.code = code; // not_installed | not_signed_in | failed
  }
}

/**
 * Run gcloud and collect its output: { code, stdout, stderr }. `args` are
 * fixed strings. `account` (which Google account to act as) goes to gcloud in
 * its environment (CLOUDSDK_CORE_ACCOUNT, gcloud's own setting for it), never
 * on the command line, so nothing a caller passes is parsed by a shell.
 */
export async function runGcloud(args, { timeoutMs = 30_000, spawn = spawnBin, account = null } = {}) {
  if (account != null && !isAccount(account)) throw new GcloudError('failed', 'That is not a Google account name.');
  const env = account ? { ...process.env, CLOUDSDK_CORE_ACCOUNT: account } : process.env;
  let child;
  try {
    child = spawn('gcloud', args, { stdio: ['ignore', 'pipe', 'pipe'], env });
  } catch (e) {
    throw new GcloudError('failed', `gcloud could not be started: ${firstLine(e.message)}`);
  }
  try {
    return await collectChild(child, { timeoutMs, label: 'gcloud' });
  } catch (e) {
    if (e?.code === 'ENOENT') throw new GcloudError('not_installed', 'The Google Cloud CLI (gcloud) is not installed, or not on PATH.');
    throw new GcloudError('failed', e?.code === 'ETIMEDOUT' ? 'gcloud took too long to answer.' : `gcloud failed: ${firstLine(e.message)}`);
  }
}

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** Is gcloud installed, and which accounts is it signed in to? Local only: no network. */
export async function gcloudStatus({ run = runGcloud, exists = commandExists } = {}) {
  if (!(await exists('gcloud'))) return { installed: false, accounts: [], account: null };
  let out;
  try {
    out = await run(['auth', 'list', '--format=json']);
  } catch (e) {
    if (e?.code === 'not_installed') return { installed: false, accounts: [], account: null };
    throw e;
  }
  const list = out.code === 0 ? parseJson(out.stdout) : null;
  const accounts = (Array.isArray(list) ? list : [])
    .filter((a) => isAccount(a?.account))
    .map((a) => ({ account: a.account, active: String(a.status || '').toUpperCase() === 'ACTIVE' }));
  return { installed: true, accounts, account: accounts.find((a) => a.active)?.account || null };
}

// What gcloud prints when it has no usable sign-in (plain substrings: no pattern to backtrack).
const SIGNED_OUT_HINTS = ['no credentialed accounts', 'not currently have an active account', 'gcloud auth login', 'reauthentication', 'invalid_grant'];
const saysSignedOut = (text) => { const t = String(text || '').toLowerCase(); return SIGNED_OUT_HINTS.some((h) => t.includes(h)); };

/**
 * A short-lived access token of `account` (default: gcloud's active account),
 * with its expiry. `gcloud config config-helper` reports both; if it answers
 * in a form this doesn't know, `gcloud auth print-access-token` is asked and
 * the token is treated as good for five minutes.
 */
export async function gcloudAccessToken({ account = null, run = runGcloud, now = Date.now } = {}) {
  if (account != null && !isAccount(account)) throw new GcloudError('failed', 'That is not a Google account name.');
  const signedOut = (out) =>
    new GcloudError('not_signed_in', saysSignedOut(out.stderr) ? 'gcloud is not signed in. Sign in with Google (gcloud auth login), then try again.' : `gcloud could not give a token: ${firstLine(out.stderr) || `exit ${out.code}`}`);
  const helper = async (extra = []) => {
    const out = await run(['config', 'config-helper', '--format=json', ...extra], { account });
    if (out.code !== 0) throw signedOut(out);
    const cred = parseJson(out.stdout)?.credential;
    const expiresAt = Date.parse(cred?.token_expiry);
    return cred?.access_token && Number.isFinite(expiresAt) ? { token: String(cred.access_token), expiresAt } : null;
  };
  let got = await helper();
  // Nearly expired: ask gcloud to renew it. A failed renewal keeps the first one.
  if (got && got.expiresAt - now() < 2 * 60_000) got = (await helper(['--force-auth-refresh']).catch(() => null)) || got;
  if (got) return got;
  const out = await run(['auth', 'print-access-token'], { account });
  const token = out.code === 0 ? firstLine(out.stdout) : '';
  if (!token) throw signedOut(out);
  return { token, expiresAt: now() + 5 * 60_000 };
}

/** `gcloud auth login`: opens the browser and exits when the sign-in is finished. */
export function startGcloudLogin({ spawn = spawnBin } = {}) {
  return spawn('gcloud', ['auth', 'login', '--brief'], { stdio: ['ignore', 'pipe', 'pipe'] });
}
