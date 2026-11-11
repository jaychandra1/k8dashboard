// AWS sign-ins over HTTP: one per AWS account. Clusters of different accounts
// never share a sign-in, although they use the same IAM Identity Center start
// URL, as in most organisations. Profiles that shared a session K8Board made
// (older versions: one per portal, plus a "-production" one) are split when
// the server starts; a session the user created is split only on request.
//   GET  /api/aws/sessions
//   POST /api/aws/sessions/sign-out  { id }
//   POST /api/aws/sessions/split     { id }
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';
import { parseAwsConfig } from '../lib/aws-sso.mjs';

const START = 'https://d-906600a9b0.awsapps.com/start';
const SHARED = 'kubepilot-d-906600a9b0'; // what older versions wrote: one per portal
const OLD_PROD = `${SHARED}-production`; // and one for clusters marked production
const session = (account) => `${SHARED}-${account}`;
const DEV = session('111122223333');
const PROD = session('444455556666');
const CRITICAL = session('555566667777');
const MINE = session('777788889999');

const execUser = (name, profile) => `- name: ${name}
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: node
      args: [eks-token.js, --token-helper, eks, --cluster, ${name}, --region, eu-west-1, --profile, ${profile}]`;
const NAMES = ['dev', 'dev-readonly', 'prod', 'critical', 'mine'];
const KUBECONFIG = `apiVersion: v1
kind: Config
current-context: dev
clusters:
${NAMES.map((n) => `- name: ${n}\n  cluster: { server: 'https://127.0.0.1:9', insecure-skip-tls-verify: true }`).join('\n')}
users:
${NAMES.map((n) => execUser(n, n)).join('\n')}
contexts:
${NAMES.map((n) => `- name: ${n}\n  context: { cluster: ${n}, user: ${n} }`).join('\n')}
`;
const AWS_CONFIG = [
  `[sso-session ${SHARED}]`, `sso_start_url = ${START}`, 'sso_region = us-east-1', '',
  `[sso-session ${OLD_PROD}]`, `sso_start_url = ${START}`, 'sso_region = us-east-1', '',
  // A session the user made with \`aws configure sso\`.
  '[sso-session corp]', `sso_start_url = ${START}`, 'sso_region = us-east-1', '',
  '[profile dev]', `sso_session = ${SHARED}`, 'sso_account_id = 111122223333', 'sso_role_name = Dev', '',
  '[profile dev-readonly]', `sso_session = ${SHARED}`, 'sso_account_id = 111122223333', 'sso_role_name = ReadOnly', '',
  '[profile prod]', `sso_session = ${SHARED}`, 'sso_account_id = 444455556666', 'sso_role_name = Admin', '',
  '[profile critical]', `sso_session = ${OLD_PROD}`, 'sso_account_id = 555566667777', 'sso_role_name = Admin', '',
  '[profile mine]', 'sso_session = corp', 'sso_account_id = 777788889999', 'sso_role_name = Admin', '',
  // The user's own AWS CLI profile in the legacy format; no cluster uses it.
  '[profile cli-only]', `sso_start_url = ${START}`, 'sso_region = us-east-1', 'sso_account_id = 888899990000', 'sso_role_name = ReadOnly', '',
].join('\n');

describe('AWS sign-ins: one per account', () => {
  let srv, dir, home;
  const awsConfig = () => parseAwsConfig(fs.readFileSync(path.join(home, '.aws', 'config'), 'utf8'));
  const sessionOf = (profile) => awsConfig().sections.get(`profile:${profile}`).values.sso_session;
  const cacheFile = (key) => path.join(home, '.aws', 'sso', 'cache', `${crypto.createHash('sha1').update(key).digest('hex')}.json`);
  const signIn = (key) => fs.writeFileSync(cacheFile(key), JSON.stringify({
    startUrl: START, region: 'us-east-1', accessToken: 'a', expiresAt: new Date(Date.now() + 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    clientId: 'c', clientSecret: 's', refreshToken: 'r',
  }));
  const json = async (p, body) => {
    const r = await srv.authed(p, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const groups = async () => Object.fromEntries((await json('/api/aws/sessions')).body.signIns.map((g) => [g.id, g]));

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-aws-signins-'));
    home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, '.aws', 'sso', 'cache'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config'), KUBECONFIG);
    fs.writeFileSync(path.join(home, '.aws', 'config'), AWS_CONFIG);
    // Signed in everywhere, the way an older version left things.
    for (const key of [SHARED, OLD_PROD, 'corp']) signIn(key);
    srv = await startServer({ env: { KUBEPILOT_DEMO: '', KUBECONFIG: path.join(dir, 'config'), HOME: home, USERPROFILE: home } });
  });
  after(async () => {
    await srv?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('at startup, accounts that shared a sign-in each get their own; the old token is not carried over', async () => {
    assert.deepEqual(['dev', 'dev-readonly', 'prod', 'critical'].map(sessionOf), [DEV, DEV, PROD, CRITICAL]);
    const sections = awsConfig().sections;
    assert.deepEqual([SHARED, OLD_PROD].map((n) => sections.has(`sso-session:${n}`)), [false, false], 'the shared sessions are gone');
    assert.deepEqual([SHARED, OLD_PROD].map((n) => fs.existsSync(cacheFile(n))), [false, false], 'with their tokens');
    // Nothing of the user's own is touched: their session, its token, their CLI profile.
    assert.equal(sessionOf('mine'), 'corp');
    assert.equal(fs.existsSync(cacheFile('corp')), true);
    assert.equal(sections.get('profile:cli-only').values.sso_start_url, START);
    assert.equal(fs.readdirSync(path.join(home, '.aws')).filter((f) => f.startsWith('config.k8board-backup-')).length, 1, 'the file as it was is kept once');

    const g = await groups();
    assert.deepEqual(Object.keys(g).sort(), [DEV, PROD, CRITICAL, 'corp'].sort());
    // One account each, each needing its own sign-in; two roles of an account share it.
    assert.deepEqual(
      [DEV, PROD, CRITICAL].map((id) => [g[id].accountId, g[id].accounts, g[id].managed, g[id].shared, g[id].canSplit, g[id].signedIn]),
      [['111122223333', 1, true, false, false, false], ['444455556666', 1, true, false, false, false], ['555566667777', 1, true, false, false, false]]
    );
    assert.deepEqual(g[DEV].clusters.map((c) => [c.context, c.current, c.roleName, c.own]), [['dev', true, 'Dev', true], ['dev-readonly', false, 'ReadOnly', true]]);
    // The user's own session still signs in the way they set it up, until they ask.
    assert.deepEqual([g.corp.managed, g.corp.shared, g.corp.canSplit, g.corp.signedIn, g.corp.clusters.map((c) => c.context)], [false, true, true, true, ['mine']]);
    assert.equal('production' in g[DEV], false);
    assert.equal('legacyProfiles' in (await json('/api/aws/sessions')).body, false);
  });

  test('a sign-in for one account does not sign in another on the same portal', async () => {
    signIn(DEV);
    const g = await groups();
    assert.deepEqual([g[DEV].signedIn, g[PROD].signedIn, g[CRITICAL].signedIn], [true, false, false]);
  });

  test('sign out: that account\'s token is gone from this computer; no other account is affected', async () => {
    signIn(PROD);
    const r = await json('/api/aws/sessions/sign-out', { id: DEV });
    assert.deepEqual([r.status, r.body.signedOut, r.body.clusters, r.body.current], [200, true, ['dev', 'dev-readonly'], true]);
    assert.deepEqual([fs.existsSync(cacheFile(DEV)), fs.existsSync(cacheFile(PROD))], [false, true]);
    const g = await groups();
    assert.deepEqual([g[DEV].signedIn, g[PROD].signedIn], [false, true]);
    // dev is the open cluster: its requests stop at once (no token helper runs)
    // and say a sign-in is needed, which brings the UI's sign-in dialog up.
    const started = Date.now();
    const ns = await json('/api/namespaces');
    assert.deepEqual([ns.status, ns.body.code], [424, 'cluster_auth_required']);
    assert.ok(Date.now() - started < 1000);
  });

  test('a sign-in the user set up is split by account only on request; their session and its token stay', async () => {
    const r = await json('/api/aws/sessions/split', { id: 'corp' });
    assert.deepEqual([r.status, r.body.moved, r.body.clusters, r.body.current], [200, 1, ['mine'], false]);
    assert.equal(sessionOf('mine'), MINE);
    assert.equal(awsConfig().sections.has('sso-session:corp'), true);
    assert.equal(fs.existsSync(cacheFile('corp')), true);
    const g = await groups();
    assert.equal('corp' in g, false);
    assert.deepEqual([g[MINE].accountId, g[MINE].shared, g[MINE].canSplit, g[MINE].signedIn], ['777788889999', false, false, false]);
  });

  test('bad requests are refused; the production switch no longer exists', async () => {
    assert.equal((await json('/api/aws/sessions/sign-out', { id: 'nope' })).status, 400);
    assert.equal((await json('/api/aws/sessions/split', { id: 'nope' })).status, 400);
    assert.equal((await json('/api/aws/sessions/split', {})).status, 400);
    assert.equal((await json('/api/aws/production', { context: 'prod', production: true })).status, 404);
    assert.equal((await json('/api/aws/profiles/use-shared-sign-in', { startUrl: START, profiles: ['cli-only'] })).status, 404);
  });
});
