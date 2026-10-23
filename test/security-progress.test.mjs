// Trivy Operator progress and remediation over HTTP, against a fake API
// server: the operator Deployment, its scan Jobs and pods, its log, pods
// running in the cluster and the VulnerabilityReports.
//   GET /api/security/progress        what the operator is doing, and why scans fail
//   GET /api/security/vulnerabilities coverage per (workload, container) + remediation
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';

const OP_NS = 'trivy-system';
const labels = (ns, kind, name, container) => ({
  'trivy-operator.resource.namespace': ns, 'trivy-operator.resource.kind': kind,
  'trivy-operator.resource.name': name, 'trivy-operator.container.name': container,
});
const PODS = [
  { metadata: { namespace: 'shop', name: 'web-1', ownerReferences: [{ kind: 'ReplicaSet', name: 'web-7f9', controller: true }] }, spec: { containers: [{ name: 'app', image: 'acme/web:1.2' }] }, status: { phase: 'Running' } },
  { metadata: { namespace: 'shop', name: 'api-1', ownerReferences: [{ kind: 'ReplicaSet', name: 'api-5c4', controller: true }] }, spec: { containers: [{ name: 'api', image: '123456789012.dkr.ecr.eu-west-1.amazonaws.com/api:7' }] }, status: { phase: 'Running' } },
  { metadata: { namespace: 'shop', name: 'db-0', ownerReferences: [{ kind: 'StatefulSet', name: 'db', controller: true }] }, spec: { containers: [{ name: 'pg', image: 'postgres:16' }] }, status: { phase: 'Running' } },
];
const REPORTS = [{
  metadata: { namespace: 'shop', name: 'replicaset-web-7f9-app', labels: labels('shop', 'ReplicaSet', 'web-7f9', 'app'), creationTimestamp: '2026-10-23T09:00:00Z' },
  report: {
    updateTimestamp: '2026-10-23T09:30:00Z',
    artifact: { repository: 'acme/web', tag: '1.2' }, os: { family: 'alpine', name: '3.18.0' },
    summary: { criticalCount: 1, highCount: 1, mediumCount: 0, lowCount: 0 },
    vulnerabilities: [
      { vulnerabilityID: 'CVE-2026-1', severity: 'CRITICAL', resource: 'openssl', installedVersion: '3.1.0-r0', fixedVersion: '3.1.4-r0', class: 'os-pkgs', title: 'openssl bug' },
      { vulnerabilityID: 'CVE-2026-2', severity: 'HIGH', resource: 'openssl', installedVersion: '3.1.0-r0', fixedVersion: '3.1.2-r0', class: 'os-pkgs' },
    ],
  },
}];
const JOBS = [
  { metadata: { namespace: OP_NS, name: 'scan-vulnerabilityreport-db1', labels: { 'app.kubernetes.io/managed-by': 'trivy-operator', 'vulnerabilityReport.scanner': 'Trivy', ...labels('shop', 'StatefulSet', 'db', 'pg') } }, status: { active: 1 } },
  { metadata: { namespace: OP_NS, name: 'scan-vulnerabilityreport-api', labels: { 'app.kubernetes.io/managed-by': 'trivy-operator', 'vulnerabilityReport.scanner': 'Trivy', ...labels('shop', 'ReplicaSet', 'api-5c4', 'api') } }, status: { failed: 1, conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded', message: 'Job has reached the specified backoff limit' }] } },
];
const OP_LOG = [
  JSON.stringify({ level: 'info', msg: 'Reconciling' }),
  JSON.stringify({ level: 'error', msg: 'Scan job container', 'status.message': 'FATAL image scan error: unable to inspect the image (123456789012.dkr.ecr.eu-west-1.amazonaws.com/api:7): unexpected status code 401 Unauthorized' }),
].join('\n');

function fakeKubeApi() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const sel = url.searchParams.get('labelSelector') || '';
    const json = (obj, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const list = (items) => json({ metadata: {}, items });
    switch (url.pathname) {
      case '/apis/apps/v1/deployments':
        return list(sel === 'app.kubernetes.io/name=trivy-operator' ? [{
          metadata: { namespace: OP_NS, name: 'trivy-operator' },
          spec: { replicas: 1, template: { spec: { containers: [{ name: 'op', image: 'mirror.gcr.io/aquasec/trivy-operator:0.24.1', env: [{ name: 'OPERATOR_CONCURRENT_SCAN_JOBS_LIMIT', value: '3' }] }] } } },
          status: { readyReplicas: 1 },
        }] : []);
      case '/apis/batch/v1/jobs': return list(sel === 'app.kubernetes.io/managed-by=trivy-operator' ? JOBS : []);
      case `/api/v1/namespaces/${OP_NS}/pods`:
        if (sel === 'app.kubernetes.io/name=trivy-operator') return list([{ metadata: { namespace: OP_NS, name: 'trivy-operator-abc' }, status: { phase: 'Running' } }]);
        return list([]);
      case `/api/v1/namespaces/${OP_NS}/pods/trivy-operator-abc/log`:
        res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(OP_LOG);
      case '/api/v1/pods': return list(PODS);
      case '/apis/aquasecurity.github.io/v1alpha1/vulnerabilityreports': return list(REPORTS);
      case '/apis/aquasecurity.github.io/v1alpha1/exposedsecretreports': return list([]);
      default: return json({ kind: 'Status', code: 404 }, 404);
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

describe('Trivy Operator progress + remediation', () => {
  let srv, kube, dir;
  before(async () => {
    kube = await fakeKubeApi();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-sec-progress-'));
    const kubeconfig = path.join(dir, 'config');
    fs.writeFileSync(kubeconfig, `apiVersion: v1
kind: Config
current-context: dev
clusters:
- name: dev
  cluster: { server: 'http://127.0.0.1:${kube.address().port}', insecure-skip-tls-verify: true }
users:
- name: dev
  user: { token: dev-token }
contexts:
- name: dev
  context: { cluster: dev, user: dev }
`);
    srv = await startServer({ env: { KUBEPILOT_DEMO: '', KUBECONFIG: kubeconfig } });
  });
  after(async () => {
    await srv?.stop();
    kube?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('progress: operator, scans in flight, coverage, last report — and why scans fail, with a hint', async () => {
    const p = await (await srv.authed('/api/security/progress')).json();
    assert.deepEqual(p.operator, { found: true, namespace: OP_NS, name: 'trivy-operator', ready: 1, desired: 1, version: '0.24.1', concurrency: 3 });
    assert.deepEqual(p.jobs, { active: 1, failed: 1 });
    assert.equal(p.scanning, true);
    assert.deepEqual(p.coverage, { images: 3, scanned: 1, notScanned: 2, scanning: 1, failed: 1 });
    assert.equal(p.reports, 1);
    assert.equal(p.lastReportAt, '2026-10-23T09:30:00Z');
    assert.ok(p.failures.some((f) => /ReplicaSet api-5c4: BackoffLimitExceeded/.test(f)), JSON.stringify(p.failures));
    assert.ok(p.failures.some((f) => /401 Unauthorized/.test(f)), JSON.stringify(p.failures));
    assert.deepEqual(p.hints.map((h) => h.id), ['registry']);
    assert.match(p.hints[0].text, /AmazonEC2ContainerRegistryReadOnly/);
  });

  test('vulnerabilities: real coverage (images, not pods), pending images with their state, remediation per image', async () => {
    const v = await (await srv.authed('/api/security/vulnerabilities')).json();
    assert.equal(v.scanned, 1);
    assert.equal(v.notScanned, 2);
    assert.deepEqual(v.pending.map((pd) => [pd.image, pd.status]).sort(), [
      ['123456789012.dkr.ecr.eu-west-1.amazonaws.com/api:7', 'Failed'],
      ['postgres:16', 'Scanning'],
    ]);
    const web = v.images.find((im) => im.repository === 'acme/web');
    assert.equal(web.remediation.fixable, 2);
    assert.equal(web.remediation.osFixes, 2);
    assert.deepEqual(web.remediation.upgrades.map((u) => [u.pkg, u.installedVersion, u.upgradeTo, u.cves]), [['openssl', '3.1.0-r0', '3.1.4-r0', 2]]);
    assert.equal(web.vulnerabilities[0].class, 'os-pkgs');
  });

  test('a namespace filter narrows coverage', async () => {
    const p = await (await srv.authed('/api/security/progress?namespace=other')).json();
    assert.deepEqual(p.coverage, { images: 0, scanned: 0, notScanned: 0, scanning: 0, failed: 0 });
  });
});
