// Google GKE integration: the gcloud sign-in (lib/gcloud.mjs), cluster
// discovery and kubeconfig entries (gcp-gke.js), the token helper
// (gke-token.js) and the HTTP API. gcloud and Google's APIs are fakes: nothing
// here needs the Google Cloud CLI or a network.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from '../lib/yaml.mjs';
import { gcloudStatus, gcloudAccessToken, isAccount, GcloudError } from '../lib/gcloud.mjs';
import { discoverGkeClusters, listProjects, gkeClusterStatus, gkeEntryFor, writeGkeCluster, gkeKey, isGkeRef } from '../gcp-gke.js';
import { run as tokenHelper } from '../gke-token.js';
import { deriveHelperInvocation } from '../lib/kubeconfig-repair.mjs';
import { startServer } from './helpers/server.mjs';

const ok = (stdout) => ({ code: 0, stdout, stderr: '' });
const helperJson = (token, expiry) => ok(JSON.stringify({ credential: { access_token: token, token_expiry: new Date(expiry).toISOString() } }));

describe('gcloud as the Google sign-in', () => {
  test('status: not installed; installed with accounts and the active one', async () => {
    assert.deepEqual(await gcloudStatus({ exists: async () => false }), { installed: false, accounts: [], account: null });
    const calls = [];
    const run = async (args) => { calls.push(args); return ok(JSON.stringify([{ account: 'dev@example.com', status: 'ACTIVE' }, { account: 'ops@example.com', status: '' }, { account: 'not an account' }])); };
    assert.deepEqual(await gcloudStatus({ exists: async () => true, run }), {
      installed: true,
      accounts: [{ account: 'dev@example.com', active: true }, { account: 'ops@example.com', active: false }],
      account: 'dev@example.com',
    });
    assert.deepEqual(calls, [['auth', 'list', '--format=json']]);
    // Installed but never signed in.
    assert.deepEqual(await gcloudStatus({ exists: async () => true, run: async () => ok('[]') }), { installed: true, accounts: [], account: null });
  });

  test('access token: from config-helper with its expiry, for the chosen account', async () => {
    const calls = [];
    const now = 1_000_000;
    const run = async (args) => { calls.push(args); return helperJson('ya29.token', now + 3000_000); };
    assert.deepEqual(await gcloudAccessToken({ account: 'ops@example.com', run, now: () => now }), { token: 'ya29.token', expiresAt: now + 3000_000 });
    assert.deepEqual(calls, [['config', 'config-helper', '--format=json', '--account=ops@example.com']]);
    // No account given: gcloud's active one.
    calls.length = 0;
    await gcloudAccessToken({ run, now: () => now });
    assert.deepEqual(calls, [['config', 'config-helper', '--format=json']]);
  });

  test('access token: a nearly expired one is renewed; an unknown answer falls back to print-access-token', async () => {
    const now = 1_000_000;
    const calls = [];
    const renew = async (args) => {
      calls.push(args.join(' '));
      return args.includes('--force-auth-refresh') ? helperJson('fresh', now + 3600_000) : helperJson('old', now + 30_000);
    };
    assert.equal((await gcloudAccessToken({ run: renew, now: () => now })).token, 'fresh');
    assert.deepEqual(calls, ['config config-helper --format=json', 'config config-helper --format=json --force-auth-refresh']);
    // config-helper answers something else: print-access-token, treated as good for five minutes.
    const odd = async (args) => (args[0] === 'config' ? ok('{"unexpected":true}') : ok('ya29.printed\n'));
    assert.deepEqual(await gcloudAccessToken({ account: 'dev@example.com', run: odd, now: () => now }), { token: 'ya29.printed', expiresAt: now + 300_000 });
  });

  test('access token: signed out says so; a bad account name is refused before gcloud runs', async () => {
    const signedOut = async () => ({ code: 1, stdout: '', stderr: 'ERROR: (gcloud.config.config-helper) You do not currently have an active account selected.\nPlease run:\n  $ gcloud auth login' });
    await assert.rejects(gcloudAccessToken({ run: signedOut }), (e) => e instanceof GcloudError && e.code === 'not_signed_in' && /Sign in with Google/.test(e.message));
    let ran = false;
    await assert.rejects(gcloudAccessToken({ account: 'x; rm -rf /', run: async () => { ran = true; return ok(''); } }), /not a Google account/);
    assert.equal(ran, false);
    assert.deepEqual(['dev@example.com', 'sa-1@proj.iam.gserviceaccount.com', 'a b@c.com', '--flag', ''].map(isAccount), [true, true, false, false, false]);
  });

  test('the token helper prints an ExecCredential that expires a minute before the token does', async () => {
    const now = 2_000_000;
    const seen = [];
    const out = JSON.parse(await tokenHelper(['--account', 'dev@example.com', '--project', 'p-123456', '--location', 'europe-west1', '--cluster', 'web'], {
      token: async (o) => { seen.push(o); return { token: 'ya29.t', expiresAt: now + 3600_000 }; },
      now: () => now,
    }));
    assert.deepEqual(seen, [{ account: 'dev@example.com' }]);
    assert.deepEqual(out, {
      kind: 'ExecCredential', apiVersion: 'client.authentication.k8s.io/v1beta1', spec: {},
      status: { expirationTimestamp: new Date(now + 3540_000).toISOString(), token: 'ya29.t' },
    });
    // An almost-expired token is never reported as already expired.
    const soon = JSON.parse(await tokenHelper([], { token: async () => ({ token: 't', expiresAt: now + 10_000 }), now: () => now }));
    assert.equal(soon.status.expirationTimestamp, new Date(now + 30_000).toISOString());
  });
});

// A fake of the two Google APIs K8Board calls.
function fakeGoogle({ projects, clusters, status = {} }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    const u = new URL(url);
    const json = (code, body) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });
    if (u.host === 'cloudresourcemanager.googleapis.com') {
      const page = u.searchParams.get('pageToken') || '0';
      return json(200, { projects: projects[Number(page)] || [], ...(projects[Number(page) + 1] ? { nextPageToken: String(Number(page) + 1) } : {}) });
    }
    const project = decodeURIComponent(u.pathname.split('/')[3]);
    if (status[project]) return json(status[project], { error: { message: `Kubernetes Engine API has not been used in project ${project}` } });
    return json(200, { clusters: clusters[project] || [] });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}
const cluster = (name, location, extra = {}) => ({
  name, location, endpoint: '34.10.20.30', masterAuth: { clusterCaCertificate: 'Q0E=' }, status: 'RUNNING', currentMasterVersion: '1.31.4-gke.100', ...extra,
});
const GOOGLE = () => fakeGoogle({
  projects: [[{ projectId: 'shop-prod-1', name: 'Shop Prod' }, { projectId: 'no-gke-api', name: 'Docs' }], [{ projectId: 'shop-dev-1', name: 'Shop Dev' }, { projectId: 'BAD ID' }]],
  clusters: {
    'shop-prod-1': [cluster('web', 'europe-west1'), cluster('batch', 'europe-west1-b', { privateClusterConfig: { enablePrivateEndpoint: true }, endpoint: '10.0.0.2' })],
    'shop-dev-1': [cluster('web', 'us-central1')],
  },
  status: { 'no-gke-api': 403 },
});

describe('GKE cluster discovery and kubeconfig entries', () => {
  let dir;
  const savedKubeconfig = process.env.KUBECONFIG;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-gke-'));
    process.env.KUBECONFIG = path.join(dir, 'config');
  });
  after(() => {
    if (savedKubeconfig === undefined) delete process.env.KUBECONFIG; else process.env.KUBECONFIG = savedKubeconfig;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('every project is asked (all pages); a project without the API is skipped, not an error', async () => {
    const fetchImpl = GOOGLE();
    assert.deepEqual((await listProjects('tok', { fetchImpl })).map((p) => p.projectId), ['shop-prod-1', 'no-gke-api', 'shop-dev-1']);
    const found = await discoverGkeClusters({ token: 'tok', fetchImpl });
    assert.deepEqual([found.projects, found.skipped], [3, 1]);
    assert.deepEqual(found.clusters.map(gkeKey), ['shop-dev-1/us-central1/web', 'shop-prod-1/europe-west1-b/batch', 'shop-prod-1/europe-west1/web']);
    assert.deepEqual(found.clusters.map((c) => c.private), [false, true, false]);
    assert.ok(fetchImpl.calls.every((c) => c.auth === 'Bearer tok'));
    assert.ok(fetchImpl.calls.every((c) => /^https:\/\/(cloudresourcemanager|container)\.googleapis\.com\//.test(c.url)), 'only Google is contacted');
  });

  test('an expired Google sign-in is an error that says to sign in again', async () => {
    const expired = async () => new Response('{"error":{"message":"Request had invalid authentication credentials."}}', { status: 401 });
    await assert.rejects(discoverGkeClusters({ token: 'old', fetchImpl: expired }), (e) => e.code === 'auth' && /Sign in with Google again/.test(e.message));
    const down = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(discoverGkeClusters({ token: 't', fetchImpl: down }), (e) => e.code === 'unavailable');
  });

  test('a cluster is written with K8Board\'s token helper (no gke-gcloud-auth-plugin) and recognised afterwards', async () => {
    const { clusters } = await discoverGkeClusters({ token: 'tok', fetchImpl: GOOGLE() });
    const prodWeb = clusters.find((c) => gkeKey(c) === 'shop-prod-1/europe-west1/web');
    fs.writeFileSync(process.env.KUBECONFIG, 'apiVersion: v1\nkind: Config\ncurrent-context: kind\nclusters:\n- name: kind\n  cluster: { server: "https://127.0.0.1:6443" }\nusers:\n- name: kind\n  user: {}\ncontexts:\n- name: kind\n  context: { cluster: kind, user: kind }\n');
    assert.equal(writeGkeCluster({ cluster: prodWeb, account: 'dev@example.com' }), 'web');
    const doc = yaml.load(fs.readFileSync(process.env.KUBECONFIG, 'utf8'));
    assert.deepEqual(doc.contexts.map((c) => c.name), ['kind', 'web']);
    assert.equal(doc['current-context'], 'kind', 'the cluster in use is not changed');
    assert.deepEqual(doc.clusters.find((c) => c.name === 'web').cluster, { server: 'https://34.10.20.30', 'certificate-authority-data': 'Q0E=' });
    const exec = doc.users.find((u) => u.name === 'web').user.exec;
    assert.equal(exec.interactiveMode, 'Never');
    assert.match(exec.args.join(' '), /gke-token\.js --account dev@example\.com --project shop-prod-1 --location europe-west1 --cluster web$/);
    assert.doesNotMatch(JSON.stringify(exec), /gke-gcloud-auth-plugin/);
    assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('config.k8board-backup-')).length, 1, 'the kubeconfig as it was is kept');
    // Read back the way the server sees it.
    const kc = { contexts: doc.contexts.map((c) => ({ name: c.name, user: c.context.user })), users: doc.users.map((u) => ({ name: u.name, exec: u.user.exec })) };
    assert.deepEqual(gkeEntryFor(kc, 'web'), { project: 'shop-prod-1', location: 'europe-west1', cluster: 'web', account: 'dev@example.com' });
    assert.equal(gkeEntryFor(kc, 'kind'), null);
    // The same name in another project is a different cluster: never overwritten silently.
    const status = gkeClusterStatus(kc, clusters);
    assert.deepEqual(status.map((c) => [gkeKey(c), c.imported, c.conflict]), [
      ['shop-dev-1/us-central1/web', false, true],
      ['shop-prod-1/europe-west1-b/batch', false, false],
      ['shop-prod-1/europe-west1/web', true, false],
    ]);
    assert.ok(status.every((c) => !('endpoint' in c) && !('caData' in c)), 'endpoints and certificates are not sent to the UI');
    // A stale entry (the app moved) can be repaired like the EKS and AKS ones.
    assert.deepEqual(deriveHelperInvocation({ args: ['/old/app/gke-token.js', '--account', 'dev@example.com', '--project', 'shop-prod-1', '--location', 'europe-west1', '--cluster', 'web'] }), {
      helper: 'gke', args: ['--account', 'dev@example.com', '--project', 'shop-prod-1', '--location', 'europe-west1', '--cluster', 'web'],
    });
  });

  test('bad input is refused', () => {
    assert.deepEqual([{ project: 'shop-prod-1', location: 'europe-west1', name: 'web' }, { project: 'x', location: 'l', name: 'n' }, { project: 'shop-prod-1', location: '../etc', name: 'web' }, null].map(isGkeRef), [true, false, false, false]);
    const c = { project: 'shop-prod-1', location: 'europe-west1', name: 'web', endpoint: '34.1.2.3', caData: 'Q0E=' };
    assert.throws(() => writeGkeCluster({ cluster: { ...c, endpoint: null } }), /endpoint or certificate/);
    assert.throws(() => writeGkeCluster({ cluster: c, account: 'not an account' }), /Invalid Google account/);
  });
});

describe('GKE over HTTP', () => {
  let srv;
  const json = async (p, body) => {
    const r = await srv.authed(p, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  before(async () => { srv = await startServer({ env: { KUBEPILOT_DEMO: '' } }); });
  after(async () => { await srv?.stop(); });

  test('only clusters this sign-in discovered can be added; bad requests are refused', async () => {
    assert.equal((await json('/api/gke/import', { clusters: [] })).status, 400);
    const r = await json('/api/gke/import', { clusters: [{ project: 'shop-prod-1', location: 'europe-west1', name: 'web', endpoint: 'evil.example.com', caData: 'x' }, { name: 'zzz' }] });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.imported, r.body.failed.map((f) => f.name)], [[], ['web', 'zzz']]);
    assert.match(r.body.failed[0].error, /Unknown cluster/);
    assert.equal((await json('/api/gke/clusters?account=not%20an%20account')).status, 400);
    assert.deepEqual((await json('/api/gke/login/status')).body, { status: 'idle' });
    assert.deepEqual((await json('/api/gke/login/cancel', {})).body, { ok: true });
  });

  test('status reports whether gcloud is installed, and nothing else about the machine', async () => {
    const r = await json('/api/gke/status');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['account', 'accounts', 'installed', 'loggedIn']);
    assert.equal(typeof r.body.installed, 'boolean');
  });
});
