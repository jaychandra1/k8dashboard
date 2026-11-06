// Removing a cluster (POST /api/config/contexts/remove): the preview says
// exactly what goes, entries other clusters use are kept, a backup is made,
// the selected cluster moves on, pins follow, and the AWS profile goes only
// on request when nothing else uses it. Plus the pure helper.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';
import { parseKubeconfigDoc, removeContextFromDoc } from '../lib/kubeconfig-remove.mjs';
import { load } from '../lib/yaml.mjs';
import { parseAwsConfig } from '../lib/aws-sso.mjs';

const execUser = (name, profile) => `- name: ${name}
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: node
      args: [eks-token.js, --token-helper, eks, --cluster, ${name}, --region, eu-west-1, --profile, ${profile}]`;
// dev; prod; staging shares prod's cluster entry and AWS profile.
const KUBECONFIG = `apiVersion: v1
kind: Config
current-context: dev
clusters:
- name: dev-c
  cluster: { server: 'https://127.0.0.1:9', insecure-skip-tls-verify: true }
- name: prod-c
  cluster: { server: 'https://127.0.0.1:9', insecure-skip-tls-verify: true }
users:
${execUser('dev-u', 'dev')}
${execUser('prod-u', 'prod')}
${execUser('staging-u', 'prod')}
contexts:
- name: dev
  context: { cluster: dev-c, user: dev-u }
- name: prod
  context: { cluster: prod-c, user: prod-u }
- name: staging
  context: { cluster: prod-c, user: staging-u }
`;
const AWS_CONFIG = [
  '[sso-session s]', 'sso_start_url = https://d-906600a9b0.awsapps.com/start', 'sso_region = us-east-1', '',
  '[profile dev]', 'sso_session = s', 'sso_account_id = 111122223333', 'sso_role_name = Dev', '',
  '[profile prod]', 'sso_session = s', 'sso_account_id = 444455556666', 'sso_role_name = Admin', '',
].join('\n');

describe('kubeconfig-remove: removeContextFromDoc', () => {
  test('keeps entries another context uses, picks the next current context', () => {
    const doc = parseKubeconfigDoc(KUBECONFIG);
    const out = removeContextFromDoc(doc, 'dev', { nextCurrent: 'staging' });
    assert.deepEqual([out.user, out.cluster, out.wasCurrent], [{ name: 'dev-u', removed: true }, { name: 'dev-c', removed: true }, true]);
    assert.equal(out.doc['current-context'], 'staging');
    assert.equal(doc.contexts.length, 3, 'the input is not changed');
    const prod = removeContextFromDoc(doc, 'prod');
    assert.deepEqual([prod.user.removed, prod.cluster.removed], [true, false], 'staging still uses prod-c');
    const fromOtherFile = removeContextFromDoc(doc, 'prod', { inUse: { users: new Set(['prod-u']) } });
    assert.equal(fromOtherFile.user.removed, false, 'a context in another kubeconfig file uses it');
    assert.throws(() => removeContextFromDoc(doc, 'nope'));
  });
});

describe('POST /api/config/contexts/remove', () => {
  let srv, dir, kubeconfig;
  const kube = () => load(fs.readFileSync(kubeconfig, 'utf8'));
  const aws = () => parseAwsConfig(fs.readFileSync(path.join(srv.home, '.aws', 'config'), 'utf8'));
  const post = async (body, headers = {}) => {
    const r = await srv.authed('/api/config/contexts/remove', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const getJson = async (p) => (await srv.authed(p)).json();

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-remove-cluster-'));
    kubeconfig = path.join(dir, 'config');
    fs.writeFileSync(kubeconfig, KUBECONFIG);
    srv = await startServer({ env: { KUBEPILOT_DEMO: '', KUBECONFIG: kubeconfig } });
    fs.mkdirSync(path.join(srv.home, '.aws'), { recursive: true });
    fs.writeFileSync(path.join(srv.home, '.aws', 'config'), AWS_CONFIG);
    await srv.authed('/api/settings/pins', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pins: ['prod', 'dev'] }) });
  });
  after(async () => {
    await srv?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the preview says what goes and what stays; nothing changes', async () => {
    const before = fs.readFileSync(kubeconfig, 'utf8');
    const { status, body } = await post({ context: 'prod', dryRun: true });
    assert.equal(status, 200);
    assert.deepEqual(body.user, { name: 'prod-u', removed: true, usedBy: [] });
    assert.deepEqual(body.cluster, { name: 'prod-c', removed: false, usedBy: ['staging'] });
    assert.deepEqual([body.current, body.switchTo, body.lastCluster, body.file], [false, null, false, 'config']);
    assert.deepEqual(body.awsProfile, { name: 'prod', removable: false, usedBy: ['staging'] });
    assert.equal(fs.readFileSync(kubeconfig, 'utf8'), before);
  });

  test("an AWS profile another cluster uses can't be removed with it", async () => {
    const { status } = await post({ context: 'prod', removeAwsProfile: true });
    assert.equal(status, 400);
    assert.ok(kube().contexts.some((c) => c.name === 'prod'), 'nothing removed');
  });

  test('removing prod: its entries go, the shared cluster entry stays, a backup is kept, the pin goes', async () => {
    const { status, body } = await post({ context: 'prod' });
    assert.equal(status, 200);
    assert.equal(body.removed, true);
    const k = kube();
    assert.deepEqual(k.contexts.map((c) => c.name), ['dev', 'staging']);
    assert.deepEqual(k.users.map((u) => u.name), ['dev-u', 'staging-u']);
    assert.deepEqual(k.clusters.map((c) => c.name), ['dev-c', 'prod-c']);
    const backup = path.join(dir, body.backup);
    assert.match(body.backup, /^config\.k8board-backup-\d{8}-\d{6}$/);
    assert.match(fs.readFileSync(backup, 'utf8'), /name: prod\n/);
    assert.deepEqual((await getJson('/api/settings/pins')).pins, ['dev']);
    assert.deepEqual((await getJson('/api/config/context')).contexts, ['dev', 'staging']);
    assert.ok(aws().sections.has('profile:prod'), 'AWS profile kept by default');
  });

  test('removing the selected cluster moves to another; its AWS profile goes on request', async () => {
    const preview = (await post({ context: 'dev', dryRun: true })).body;
    assert.deepEqual([preview.current, preview.switchTo, preview.awsProfile], [true, 'staging', { name: 'dev', removable: true, usedBy: [] }]);
    const { status, body } = await post({ context: 'dev', removeAwsProfile: true });
    assert.equal(status, 200);
    assert.deepEqual([body.currentContext, body.awsProfileRemoved], ['staging', true]);
    assert.equal(kube()['current-context'], 'staging');
    assert.equal((await getJson('/api/config/context')).currentContext, 'staging');
    const cfg = aws();
    assert.equal(cfg.sections.has('profile:dev'), false);
    assert.ok(cfg.sections.has('sso-session:s'), 'prod still signs in with the session');
  });

  test('removing the last cluster leaves no kubeconfig loaded', async () => {
    const { body } = await post({ context: 'staging' });
    assert.equal(body.lastCluster, true);
    assert.deepEqual(kube().contexts, []);
    const status = await getJson('/api/config/status');
    assert.equal(status.loaded, false);
  });

  test('bad requests and AI agents are refused', async () => {
    fs.writeFileSync(kubeconfig, KUBECONFIG);
    await srv.authed('/api/config/reload', { method: 'POST' });
    assert.equal((await post({ context: 'nope' })).status, 400);
    assert.equal((await post({ context: 'dev', dryRun: 'yes' })).status, 400);
    assert.equal((await post({ context: 'dev' }, { 'X-K8Board-Source': 'mcp' })).status, 403);
    assert.ok(kube().contexts.some((c) => c.name === 'dev'));
  });
});
