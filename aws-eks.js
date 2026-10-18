// CLI-free AWS EKS integration, built on the AWS SDK for JavaScript v3.
// No `aws` binary and no reliance on the local credential chain beyond what the
// SDK reads itself. Handles the three sign-in methods (SSO / access keys /
// assume-role), discovers EKS clusters across accounts and regions, and writes
// kubeconfig entries whose auth execs our native eks-token.js helper.
import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import { EKSClient, ListClustersCommand, DescribeClusterCommand } from '@aws-sdk/client-eks';
import { STSClient, GetCallerIdentityCommand, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { SSOClient, ListAccountsCommand, ListAccountRolesCommand, GetRoleCredentialsCommand } from '@aws-sdk/client-sso';
import { loadSharedConfigFiles, loadSsoSessionData } from '@smithy/shared-ini-file-loader';
import { awsConfigPath, ensureSsoSession, profileSsoInfo, saveAwsConfig, upsertSsoProfile } from './lib/aws-sso.mjs';
import { execEntry } from './lib/paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const EKS_TOKEN_HELPER = path.join(__dirname, 'eks-token.js');

// Static AWS region list. We deliberately do NOT call EC2 DescribeRegions —
// that pulls in @aws-sdk/client-ec2 (~26 MB / 3k+ files), which bloated the
// installer just to list regions. Listing EKS clusters in a region with none is
// a cheap no-op (and unavailable/opt-out regions just error and are skipped), so
// searching a broad static list is fine.
const AWS_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'ca-central-1', 'ca-west-1',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-central-2',
  'eu-north-1', 'eu-south-1', 'eu-south-2',
  'ap-south-1', 'ap-south-2',
  'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-4',
  'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
  'ap-east-1',
  'sa-east-1',
  'me-south-1', 'me-central-1', 'af-south-1', 'il-central-1',
];
const awsDir = () => path.join(process.env.HOME || os.homedir(), '.aws');
const kubeconfigPath = () => process.env.KUBECONFIG || path.join(process.env.HOME || os.homedir(), '.kube', 'config');

// Is there any [profile <name>] (or [<name>] for default) section, SSO or not?
const profileExists = (text, name) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
  return new RegExp(`^\\s*\\[\\s*(profile\\s+)?${escaped}\\s*\\]`, 'm').test(text);
};

// ---- private file writes --------------------------------------------------
// Atomic, owner-only write: tmp file + rename, then an explicit chmod (rename
// keeps the tmp file's 0600, but a pre-existing target may have been looser).
function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort (e.g. Windows) */ }
}

// ---- shared config (profiles) -------------------------------------------
export async function listProfiles() {
  try {
    const { configFile = {}, credentialsFile = {} } = await loadSharedConfigFiles({ ignoreCache: true });
    const sessions = await loadSsoSessionData().catch(() => ({}));
    // "sso-session.<name>" (and other "<type>.<name>") sections are not profiles.
    const isProfile = (n) => !/^(sso-session|services)\./.test(n);
    const names = new Set([...Object.keys(configFile), ...Object.keys(credentialsFile)].filter(isProfile));
    return [...names].map((name) => {
      const c = { ...(configFile[name] || {}), ...(credentialsFile[name] || {}) };
      const s = c.sso_session ? sessions[c.sso_session] || {} : null;
      const type = c.sso_start_url || c.sso_session ? 'sso' : c.role_arn ? 'role' : c.aws_access_key_id ? 'access-key' : 'other';
      return {
        name, type,
        ssoStartUrl: s ? s.sso_start_url : c.sso_start_url,
        ssoRegion: s ? s.sso_region : c.sso_region,
        ssoSession: c.sso_session || undefined,
        region: c.region, ssoAccountId: c.sso_account_id, ssoRoleName: c.sso_role_name,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; }
}

// ---- credential resolution ----------------------------------------------
// Returns { credentials, region, profile? } for a concrete set of static creds.
export async function resolveCredentials(method, opts = {}) {
  if (method === 'access-key') {
    const { accessKeyId, secretAccessKey, sessionToken } = opts;
    if (!accessKeyId || !secretAccessKey) throw new Error('Access Key ID and Secret Access Key are required');
    return { credentials: { accessKeyId, secretAccessKey, sessionToken: sessionToken || undefined }, region: opts.region };
  }
  if (method === 'role') {
    const { roleArn, sessionName, region } = opts;
    if (!roleArn) throw new Error('Role ARN is required');
    // Base credentials come from the ambient chain / source profile.
    const sts = new STSClient({ region: region || 'us-east-1', ...(opts.sourceProfile ? { profile: opts.sourceProfile } : {}) });
    const out = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: sessionName || 'kubepilot', DurationSeconds: 3600 }));
    const c = out.Credentials;
    return { credentials: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken }, region };
  }
  throw new Error(`Unsupported credential method: ${method}`);
}

export async function validateCredentials(credentials, region) {
  const sts = new STSClient({ region: region || 'us-east-1', credentials });
  const id = await sts.send(new GetCallerIdentityCommand({}));
  return { account: id.Account, arn: id.Arn, userId: id.UserId };
}

// ---- region + cluster discovery -----------------------------------------
function regionsFor(region) {
  // Ensure the caller's own region is searched even if it's not in the list.
  return region && !AWS_REGIONS.includes(region) ? [region, ...AWS_REGIONS] : AWS_REGIONS;
}

// `regions` (an explicit list from the UI) wins; otherwise the broad static scan.
export async function discoverClusters({ credentials, region, regions, account, accountName }) {
  const wanted = Array.isArray(regions) ? [...new Set(regions.filter(Boolean))] : [];
  const scan = wanted.length ? wanted : regionsFor(region);
  const perRegion = await Promise.all(scan.map(async (r) => {
    try {
      const eks = new EKSClient({ region: r, credentials });
      const out = await eks.send(new ListClustersCommand({}));
      return (out.clusters || []).map((name) => ({ name, region: r, account, accountName }));
    } catch { return []; }
  }));
  return { clusters: perRegion.flat(), regions: scan.length, scanned: scan };
}

// ---- AWS SSO (IAM Identity Center) ---------------------------------------
// Sign-in (browser PKCE / device code), the [sso-session] config and the
// refreshable token cache live in lib/aws-sso.mjs. Below: what a signed-in
// access token can do.

// Granular SSO steps (guided account → role → clusters flow).
export async function ssoListAccounts({ accessToken, ssoRegion }) {
  const sso = new SSOClient({ region: ssoRegion });
  const accounts = []; let nextToken;
  do { const out = await sso.send(new ListAccountsCommand({ accessToken, nextToken })); accounts.push(...(out.accountList || [])); nextToken = out.nextToken; } while (nextToken);
  return accounts.map((a) => ({ accountId: a.accountId, accountName: a.accountName, email: a.emailAddress })).sort((a, b) => (a.accountName || '').localeCompare(b.accountName || ''));
}
export async function ssoListRoles({ accessToken, ssoRegion }, accountId) {
  const sso = new SSOClient({ region: ssoRegion });
  const roles = []; let nextToken;
  do { const out = await sso.send(new ListAccountRolesCommand({ accessToken, accountId, nextToken })); roles.push(...(out.roleList || [])); nextToken = out.nextToken; } while (nextToken);
  return roles.map((r) => r.roleName);
}
export async function ssoRoleCredentials({ accessToken, ssoRegion }, accountId, roleName) {
  const sso = new SSOClient({ region: ssoRegion });
  const rc = await sso.send(new GetRoleCredentialsCommand({ accessToken, accountId, roleName }));
  return { accessKeyId: rc.roleCredentials.accessKeyId, secretAccessKey: rc.roleCredentials.secretAccessKey, sessionToken: rc.roleCredentials.sessionToken };
}

// ---- kubeconfig writing (native, no `aws` binary) -----------------------
export class KubeconfigParseError extends Error {
  constructor(file, cause) {
    super(`Existing kubeconfig at ${file} could not be parsed — refusing to overwrite it (${cause?.message || cause})`);
    this.name = 'KubeconfigParseError';
    this.cause = cause;
  }
}

function loadKube() {
  const p = kubeconfigPath();
  let doc = { apiVersion: 'v1', kind: 'Config', clusters: [], users: [], contexts: [], 'current-context': '' };
  if (fs.existsSync(p)) {
    let parsed;
    try { parsed = yaml.load(fs.readFileSync(p, 'utf8')); } catch (e) { throw new KubeconfigParseError(p, e); }
    if (parsed != null && (typeof parsed !== 'object' || Array.isArray(parsed))) throw new KubeconfigParseError(p, new Error('top level is not a mapping'));
    doc = parsed || doc;
  }
  doc.clusters = doc.clusters || []; doc.users = doc.users || []; doc.contexts = doc.contexts || [];
  return { p, doc };
}

// Before the first overwrite in this process, keep a copy of the user's
// kubeconfig next to it (<file>.kubepilot-backup-YYYYMMDD-HHmmss).
let kubeconfigBackedUp = false;
function backupKubeconfigOnce(p) {
  if (kubeconfigBackedUp) return;
  if (fs.existsSync(p)) {
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const backup = `${p}.kubepilot-backup-${ts}`;
    fs.copyFileSync(p, backup);
    try { fs.chmodSync(backup, 0o600); } catch { /* best effort */ }
  }
  kubeconfigBackedUp = true;
}

function saveKube(p, doc) {
  backupKubeconfigOnce(p);
  writePrivate(p, yaml.dump(doc, { noRefs: true, lineWidth: -1 }));
}

function upsert(arr, name, entry) {
  const i = arr.findIndex((x) => x.name === name);
  if (i >= 0) arr[i] = entry; else arr.push(entry);
}

// Write a cluster/user/context for one EKS cluster. `credsRef` is either
// { profile } (access-key / role / SSO saved as a profile) or nothing (helper
// falls back to the ambient environment / instance role).
export async function writeCluster({ credentials, region, name, alias, profile }) {
  const eks = new EKSClient({ region, credentials });
  const d = await eks.send(new DescribeClusterCommand({ name }));
  const c = d.cluster;
  const server = c.endpoint;
  const caData = c.certificateAuthority?.data;
  const ctxName = alias || name;

  const { p, doc } = loadKube();
  upsert(doc.clusters, ctxName, { name: ctxName, cluster: { server, 'certificate-authority-data': caData } });
  // Packaged app: `KubePilot --token-helper eks …`; source/Docker: `node eks-token.js …`
  // (lib/paths.mjs execEntry decides; lib/kubeconfig-repair.mjs fixes stale ones).
  const helper = execEntry('eks', ['--cluster', name, '--region', region, ...(profile ? ['--profile', profile] : [])]);
  upsert(doc.users, ctxName, {
    name: ctxName,
    user: {
      exec: {
        apiVersion: 'client.authentication.k8s.io/v1beta1',
        command: helper.command,
        args: helper.args,
        ...(helper.env ? { env: helper.env } : {}),
        interactiveMode: 'Never',
        provideClusterInfo: false,
      },
    },
  });
  upsert(doc.contexts, ctxName, { name: ctxName, context: { cluster: ctxName, user: ctxName } });
  saveKube(p, doc);
  return ctxName;
}

// ---- ~/.aws profile writing ----------------------------------------------
// Values land in INI files, so they must be single-line and must not contain
// `[` / `]` (which would open a new section) — reject anything else.
const INI_VALUE = /^[A-Za-z0-9_:/.+=@,-]{1,256}$/;
const ACCESS_KEY_ID = /^[A-Z0-9]{16,128}$/;
const SECRET_KEY = /^[A-Za-z0-9/+=]{1,256}$/;
const SESSION_TOKEN = /^[A-Za-z0-9/+=._-]{1,8192}$/;
const SSO_START_URL = /^https:\/\/[A-Za-z0-9._~:/-]{1,512}$/;
const requireMatch = (label, value, re) => {
  if (!re.test(String(value))) throw new Error(`Invalid ${label}`);
  return String(value);
};
const optionalMatch = (label, value, re) => (value == null || value === '' ? undefined : requireMatch(label, value, re));

// The SDK caches ~/.aws/config + credentials per process; after we write them,
// re-read with ignoreCache so an in-process fromNodeProviderChain({ profile })
// sees the new profile (the exec helper runs in a fresh process anyway).
const refreshSdkIniCache = () => loadSharedConfigFiles({ ignoreCache: true }).catch(() => {});
/** Re-read ~/.aws after another module changed it (e.g. a sign-in converted profiles). */
export const refreshAwsConfigCache = refreshSdkIniCache;

// Replace (or append) one `[header]` section in an INI file, atomically, 0600.
function setIniBlock(file, header, lines) {
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp(`\\[${header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\][^\\[]*`, 'm');
  const block = `[${header}]\n${lines.filter(Boolean).join('\n')}\n`;
  text = re.test(text) ? text.replace(re, block) : (text.trim() ? `${text.trim()}\n\n${block}` : block);
  writePrivate(file, text);
  refreshSdkIniCache();
}
function removeIniBlock(file, header) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  const re = new RegExp(`\\[${header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\][^\\[]*`, 'm');
  if (!re.test(text)) return;
  writePrivate(file, text.replace(re, '').trim() + '\n');
  refreshSdkIniCache();
}

// Persist static credentials as an ~/.aws profile so eks-token.js can read them
// at runtime (for access-key / assume-role sign-ins).
export function saveProfile(name, { accessKeyId, secretAccessKey, sessionToken, roleArn, sourceProfile, sessionName, region }) {
  const profile = requireMatch('profile name', name, INI_VALUE);
  const dir = awsDir();
  fs.mkdirSync(dir, { recursive: true });
  const credFile = path.join(dir, 'credentials');
  const cfgFile = path.join(dir, 'config');
  if (accessKeyId) {
    const id = requireMatch('access key id', accessKeyId, ACCESS_KEY_ID);
    const secret = requireMatch('secret access key', secretAccessKey, SECRET_KEY);
    const token = optionalMatch('session token', sessionToken, SESSION_TOKEN);
    setIniBlock(credFile, profile, [`aws_access_key_id = ${id}`, `aws_secret_access_key = ${secret}`, token ? `aws_session_token = ${token}` : '']);
  }
  const cfgLines = [];
  if (roleArn) {
    cfgLines.push(`role_arn = ${requireMatch('role ARN', roleArn, INI_VALUE)}`);
    cfgLines.push(`source_profile = ${requireMatch('source profile', sourceProfile, INI_VALUE)}`);
    const sn = optionalMatch('session name', sessionName, INI_VALUE);
    if (sn) cfgLines.push(`role_session_name = ${sn}`);
  }
  const rg = optionalMatch('region', region, INI_VALUE);
  if (rg) cfgLines.push(`region = ${rg}`);
  if (cfgLines.length) setIniBlock(cfgFile, profile === 'default' ? 'default' : `profile ${profile}`, cfgLines);
  return profile;
}

// Persist an IAM Identity Center (SSO) profile — no static keys — in the
// format `aws configure sso` writes: the profile names an [sso-session], whose
// refreshable token (lib/aws-sso.mjs adoptSsoLogin) the SDK's fromSSO renews on
// its own. Returns the profile name actually used: an existing profile of a
// *different* start URL is never clobbered — a `-2`, `-3`, … suffix is chosen.
export async function saveSsoProfile(name, { startUrl, ssoRegion, accountId, roleName, region }) {
  const base = requireMatch('profile name', name, INI_VALUE);
  const url = requireMatch('SSO start URL', startUrl, SSO_START_URL);
  const sr = requireMatch('SSO region', ssoRegion, INI_VALUE);
  const acct = requireMatch('SSO account id', accountId, /^\d{12}$/);
  const role = requireMatch('SSO role name', roleName, INI_VALUE);
  const rg = optionalMatch('region', region, INI_VALUE);

  const configFile = awsConfigPath();
  let text = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
  const session = ensureSsoSession(text, { startUrl: url, ssoRegion: sr });
  text = session.text;
  let chosen = base;
  for (let i = 2; ; i++) {
    const info = profileSsoInfo(text, chosen);
    // Free: absent, or already an SSO profile of this start URL (re-import updates it).
    const taken = info ? !!info.startUrl && info.startUrl !== url : profileExists(text, chosen);
    if (!taken) break;
    chosen = `${base}-${i}`;
  }
  text = upsertSsoProfile(text, { name: chosen, sessionName: session.name, accountId: acct, roleName: role, region: rg });
  saveAwsConfig(configFile, text);
  // Stale static keys under the same name (written by older versions) would
  // take precedence over the SSO config — drop them.
  removeIniBlock(path.join(awsDir(), 'credentials'), chosen);
  await refreshSdkIniCache();
  return chosen;
}
