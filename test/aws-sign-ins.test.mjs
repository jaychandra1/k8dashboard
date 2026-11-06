// AWS sign-ins over HTTP: which clusters share a sign-in, signing out, marking
// a cluster production (its own sign-in), and older-format profiles changed
// only on request. A dev and a prod EKS cluster share one IAM Identity Center
// start URL, as in most organisations.
//   GET  /api/aws/sessions
//   POST /api/aws/sessions/sign-out           { id }
//   POST /api/aws/production                  { context, production }
//   POST /api/aws/profiles/use-shared-sign-in { startUrl, profiles }
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';
import { parseAwsConfig } from '../lib/aws-sso.mjs';

const START = 'https://d-906600a9b0.awsapps.com/start';
const SHARED = 'kubepilot-d-906600a9b0';
const PROD = `${SHARED}-production`;

const execUser = (name, profile) => `- name: ${name}
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: node
      args: [eks-token.js, --token-helper, eks, --cluster, ${name}, --region, eu-west-1, --profile, ${profile}]`;
const KUBECONFIG = `apiVersion: v1
kind: Config
current-context: dev
clusters:
- name: dev
  cluster: { server: 'https://127.0.0.1:9', insecure-skip-tls-verify: true }
- name: prod
  cluster: { server: 'https://127.0.0.1:9', insecure-skip-tls-verify: true }
users:
${execUser('dev', 'dev')}
${execUser('prod', 'prod')}
contexts:
- name: dev
  context: { cluster: dev, user: dev }
- name: prod
  context: { cluster: prod, user: prod }
`;
const AWS_CONFIG = [
  `[sso-session ${SHARED}]`, `sso_start_url = ${START}`, 'sso_region = us-east-1', '',
  '[profile dev]', `sso_session = ${SHARED}`, 'sso_account_id = 111122223333', 'sso_role_name = Dev', '',
  '[profile prod]', `sso_session = ${SHARED}`, 'sso_account_id = 444455556666', 'sso_role_name = Admin', '',
  // The user's own AWS CLI profile in the legacy format; no cluster uses it.
  '[profile cli-only]', `sso_start_url = ${START}`, 'sso_region = us-east-1', 'sso_account_id = 777788889999', 'sso_role_name = ReadOnly', '',
].join('\n');

describe('AWS sign-ins', () => {
  let srv, dir;
  const awsConfig = () => parseAwsConfig(fs.readFileSync(path.join(srv.home, '.aws', 'config'), 'utf8'));
  const cacheFile = (key) => path.join(srv.home, '.aws', 'sso', 'cache', `${crypto.createHash('sha1').update(key).digest('hex')}.json`);
  const json = async (p, body) => {
    const r = await srv.authed(p, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const signIns = async () => (await json('/api/aws/sessions')).body;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-aws-signins-'));
    fs.writeFileSync(path.join(dir, 'config'), KUBECONFIG);
    srv = await startServer({ env: { KUBEPILOT_DEMO: '', KUBECONFIG: path.join(dir, 'config') } });
    fs.mkdirSync(path.join(srv.home, '.aws', 'sso', 'cache'), { recursive: true });
    fs.writeFileSync(path.join(srv.home, '.aws', 'config'), AWS_CONFIG);
    // Signed in to the shared session (an hour left, refreshable).
    fs.writeFileSync(cacheFile(SHARED), JSON.stringify({
      startUrl: START, region: 'us-east-1', accessToken: 'a', expiresAt: new Date(Date.now() + 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      clientId: 'c', clientSecret: 's', refreshToken: 'r',
    }));
  });
  after(async () => {
    await srv?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('dev and prod share one sign-in; the legacy CLI profile is listed, not changed', async () => {
    const { signIns: groups, legacyProfiles } = await signIns();
    assert.equal(groups.length, 1);
    assert.deepEqual([groups[0].sessionName, groups[0].production, groups[0].signedIn, groups[0].refreshable], [SHARED, false, true, true]);
    assert.deepEqual(groups[0].clusters.map((c) => [c.context, c.current, c.accountId]), [['dev', true, '111122223333'], ['prod', false, '444455556666']]);
    assert.deepEqual(legacyProfiles, [{ profile: 'cli-only', startUrl: START }]);
    assert.equal(awsConfig().sections.get('profile:cli-only').values.sso_start_url, START);
  });

  test('marking prod production gives it its own sign-in: the dev sign-in no longer reaches it', async () => {
    const r = await json('/api/aws/production', { context: 'prod', production: true });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.changed, r.body.production, r.body.clusters, r.body.signedIn], [true, true, ['prod'], false]);
    assert.equal(awsConfig().sections.get('profile:prod').values.sso_session, PROD);
    assert.equal(awsConfig().sections.get('profile:dev').values.sso_session, SHARED);
    const { signIns: groups } = await signIns();
    const byName = Object.fromEntries(groups.map((g) => [g.sessionName, g]));
    assert.deepEqual(byName[SHARED].clusters.map((c) => c.context), ['dev']);
    assert.equal(byName[SHARED].signedIn, true);
    assert.deepEqual([byName[PROD].production, byName[PROD].signedIn, byName[PROD].clusters.map((c) => c.context)], [true, false, ['prod']]);
    // Asking again changes nothing.
    assert.equal((await json('/api/aws/production', { context: 'prod', production: true })).body.changed, false);
  });

  test('sign out: the sign-in\'s token is gone from this computer', async () => {
    const r = await json('/api/aws/sessions/sign-out', { id: SHARED });
    assert.deepEqual([r.status, r.body.signedOut, r.body.clusters], [200, true, ['dev']]);
    assert.equal(fs.existsSync(cacheFile(SHARED)), false);
    const shared = (await signIns()).signIns.find((g) => g.sessionName === SHARED);
    assert.equal(shared.signedIn, false);
  });

  test('back from production: prod rejoins the shared sign-in and the separate session is removed', async () => {
    fs.writeFileSync(cacheFile(PROD), JSON.stringify({ startUrl: START, region: 'us-east-1', accessToken: 'p', expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
    const r = await json('/api/aws/production', { context: 'prod', production: false });
    assert.deepEqual([r.status, r.body.changed, r.body.production], [200, true, false]);
    assert.equal(awsConfig().sections.get('profile:prod').values.sso_session, SHARED);
    assert.equal(awsConfig().sections.has(`sso-session:${PROD}`), false);
    assert.equal(fs.existsSync(cacheFile(PROD)), false, 'its token is signed out with it');
    assert.equal((await signIns()).signIns.length, 1);
  });

  test('older-format profiles move to the shared sign-in only on request', async () => {
    const r = await json('/api/aws/profiles/use-shared-sign-in', { startUrl: START, profiles: ['cli-only'] });
    assert.deepEqual([r.status, r.body.converted], [200, ['cli-only']]);
    const p = awsConfig().sections.get('profile:cli-only').values;
    assert.deepEqual([p.sso_session, p.sso_start_url, p.sso_account_id], [SHARED, undefined, '777788889999']);
    assert.deepEqual((await signIns()).legacyProfiles, []);
  });

  test('bad requests are refused', async () => {
    assert.equal((await json('/api/aws/production', { context: 'prod', production: 'yes' })).status, 400);
    assert.equal((await json('/api/aws/production', { context: 'nope', production: true })).status, 400);
    assert.equal((await json('/api/aws/sessions/sign-out', { id: 'nope' })).status, 400);
    assert.equal((await json('/api/aws/profiles/use-shared-sign-in', { startUrl: START, profiles: ['dev'] })).status, 400, 'not a legacy profile');
  });
});
