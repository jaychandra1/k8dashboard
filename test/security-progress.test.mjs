// Trivy Operator progress and remediation over HTTP, against a fake API
// server: the operator Deployment, its scan Jobs and pods, its log, pods
// running in the cluster and the VulnerabilityReports.
//   GET /api/security/progress        what the operator is doing, and why scans fail
//   GET /api/security/vulnerabilities coverage per (workload, container) + remediation
//   GET /api/security/vulnerabilities/details  one image's advisory details (report download)
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
      {
        vulnerabilityID: 'CVE-2026-1', severity: 'CRITICAL', resource: 'openssl', installedVersion: '3.1.0-r0', fixedVersion: '3.1.4-r0', class: 'os-pkgs', title: 'openssl bug',
        description: 'A crafted certificate makes the parser read past its buffer.', publishedDate: '2026-01-10T00:00:00Z', lastModifiedDate: '2026-02-01T00:00:00Z',
        primaryLink: 'https://avd.aquasec.com/nvd/cve-2026-1', links: ['https://nvd.nist.gov/vuln/detail/CVE-2026-1', 'javascript:alert(1)'],
        cvss: { nvd: { V3Vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', V3Score: 9.8 } }, cvsssource: 'nvd',
      },
      { vulnerabilityID: 'CVE-2026-2', severity: 'HIGH', resource: 'openssl', installedVersion: '3.1.0-r0', fixedVersion: '3.1.2-r0', class: 'os-pkgs' },
    ],
  },
}, {
  // The previous image of Deployment web: its ReplicaSet is kept (scaled to 0)
  // for rollback, so the report stays though no pod runs it.
  metadata: { namespace: 'shop', name: 'replicaset-web-5d2-app', labels: labels('shop', 'ReplicaSet', 'web-5d2', 'app'), creationTimestamp: '2026-10-20T09:00:00Z' },
  report: {
    updateTimestamp: '2026-10-20T09:30:00Z',
    artifact: { repository: 'acme/web', tag: '1.1' }, os: { family: 'alpine', name: '3.17.0' },
    summary: { criticalCount: 2, highCount: 1, mediumCount: 0, lowCount: 0 },
    vulnerabilities: [
      { vulnerabilityID: 'CVE-2026-1', severity: 'CRITICAL', resource: 'openssl', installedVersion: '3.1.0-r0', fixedVersion: '3.1.4-r0' },
      { vulnerabilityID: 'CVE-2026-2', severity: 'HIGH', resource: 'openssl', installedVersion: '3.1.0-r0', fixedVersion: '3.1.2-r0' },
      { vulnerabilityID: 'CVE-2025-9', severity: 'CRITICAL', resource: 'libcurl', installedVersion: '8.1.0-r0', fixedVersion: '8.4.0-r0' },
    ],
  },
}];
const CONFIG_AUDIT = [{
  metadata: { namespace: 'shop', name: 'replicaset-web-7f9', labels: labels('shop', 'ReplicaSet', 'web-7f9', ''), creationTimestamp: '2026-10-23T09:00:00Z' },
  report: {
    updateTimestamp: '2026-10-23T09:31:00Z', scanner: { name: 'Trivy', version: '0.58.1' },
    summary: { criticalCount: 0, highCount: 1, mediumCount: 0, lowCount: 0 },
    checks: [
      { checkID: 'KSV012', title: 'Runs as root user', severity: 'HIGH', category: 'Kubernetes Security Check', success: false,
        description: 'Force the running image to run as a non-root user.', remediation: 'Set securityContext.runAsNonRoot to true.',
        messages: ["Container 'app' of ReplicaSet 'web-7f9' should set 'securityContext.runAsNonRoot' to true", "Container 'sidecar' of ReplicaSet 'web-7f9' should set 'securityContext.runAsNonRoot' to true"] },
      { checkID: 'KSV011', title: 'CPU not limited', severity: 'LOW', category: 'Kubernetes Security Check', success: true },
    ],
  },
}];
const REPLICA_SETS = [
  { metadata: { namespace: 'shop', name: 'web-7f9', annotations: { 'deployment.kubernetes.io/revision': '4' }, ownerReferences: [{ kind: 'Deployment', name: 'web', controller: true }] } },
  { metadata: { namespace: 'shop', name: 'web-5d2', annotations: { 'deployment.kubernetes.io/revision': '3' }, ownerReferences: [{ kind: 'Deployment', name: 'web', controller: true }] } },
];
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
      case '/apis/apps/v1/replicasets': return list(REPLICA_SETS);
      case '/apis/aquasecurity.github.io/v1alpha1/vulnerabilityreports': return list(REPORTS);
      case '/apis/aquasecurity.github.io/v1alpha1/exposedsecretreports': return list([]);
      case '/apis/aquasecurity.github.io/v1alpha1/configauditreports': return list(CONFIG_AUDIT);
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
    assert.equal(p.reports, 2);
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

  test('vulnerabilities: an image a rollout replaced is "Not running" and not counted; the new one says what it fixed', async () => {
    const v = await (await srv.authed('/api/security/vulnerabilities')).json();
    const web = v.images.find((im) => im.image === 'acme/web:1.2');
    const old = v.images.find((im) => im.image === 'acme/web:1.1');
    assert.equal(web.active, true);
    assert.deepEqual([old.active, old.status, old.workloads[0].running], [false, 'Not running', false]);
    assert.equal(v.inactive, 1);
    // Totals and results count the running image only (deduplicated findings).
    assert.deepEqual(v.summary, { CRITICAL: 1, HIGH: 1, MEDIUM: 0, LOW: 0, UNKNOWN: 0 });
    assert.deepEqual(web.summary, v.summary);
    assert.deepEqual(v.results, { vulnerable: 1, ok: 0 });
    assert.equal(v.images[v.images.length - 1].image, 'acme/web:1.1', 'running images first');
    // 1.1 → 1.2 fixed the libcurl critical and added nothing.
    assert.equal(web.changes.length, 1);
    const c = web.changes[0];
    assert.deepEqual([c.workload, c.container, c.previousRevision, c.revision, c.previousImage], ['Deployment web', 'app', 3, 4, 'acme/web:1.1']);
    assert.deepEqual(c.resolved.map((x) => x.id), ['CVE-2025-9']);
    assert.deepEqual(c.introduced, []);
    assert.deepEqual(v.resolved, { total: 1, bySeverity: { CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 }, deployments: 1 });
    assert.equal(v.introduced.total, 0);
  });

  test('details: one image\'s advisory text, dates, CVSS vector and http(s) references, plus its remediation', async () => {
    const r = await srv.authed('/api/security/vulnerabilities/details?image=acme/web:1.2');
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.deepEqual([d.image, d.source, d.available], ['acme/web:1.2', 'operator', true]);
    assert.equal(d.details.length, 2);
    const c = d.details.find((x) => x.id === 'CVE-2026-1');
    assert.deepEqual(c, {
      id: 'CVE-2026-1', pkg: 'openssl', installedVersion: '3.1.0-r0',
      description: 'A crafted certificate makes the parser read past its buffer.',
      publishedDate: '2026-01-10T00:00:00Z', lastModifiedDate: '2026-02-01T00:00:00Z',
      cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', cvssScore: 9.8, cvssSource: 'nvd',
      links: ['https://avd.aquasec.com/nvd/cve-2026-1', 'https://nvd.nist.gov/vuln/detail/CVE-2026-1'],
    });
    assert.deepEqual(d.remediation.upgrades.map((u) => [u.pkg, u.upgradeTo]), [['openssl', '3.1.4-r0']]);
    // Another image's reports are not mixed in.
    const old = await (await srv.authed('/api/security/vulnerabilities/details?image=acme/web:1.1')).json();
    assert.deepEqual(old.details.map((x) => x.id).sort(), ['CVE-2025-9', 'CVE-2026-1', 'CVE-2026-2']);
    const none = await (await srv.authed('/api/security/vulnerabilities/details?image=acme/nope:1')).json();
    assert.deepEqual([none.available, none.details], [false, []]);
  });

  test('details: the image reference and namespace are validated', async () => {
    for (const q of ['', 'image=', 'image=a%20b', `image=${'a'.repeat(513)}`, 'image=acme/web:1.2&namespace=Bad_NS']) {
      const r = await srv.authed(`/api/security/vulnerabilities/details?${q}`);
      assert.equal(r.status, 400, q);
    }
  });

  test('checks: failed checks only, each with every message and its description (for the report)', async () => {
    const c = await (await srv.authed('/api/security/checks?kind=config')).json();
    assert.equal(c.resources.length, 1);
    const [r] = c.resources;
    assert.deepEqual([r.kind, r.name, r.namespace, r.scanner], ['ReplicaSet', 'web-7f9', 'shop', 'Trivy 0.58.1']);
    assert.equal(r.checks.length, 1);
    assert.deepEqual(r.checks[0], {
      id: 'KSV012', title: 'Runs as root user', severity: 'HIGH', category: 'Kubernetes Security Check',
      message: "Container 'app' of ReplicaSet 'web-7f9' should set 'securityContext.runAsNonRoot' to true",
      remediation: 'Set securityContext.runAsNonRoot to true.',
      messages: [
        "Container 'app' of ReplicaSet 'web-7f9' should set 'securityContext.runAsNonRoot' to true",
        "Container 'sidecar' of ReplicaSet 'web-7f9' should set 'securityContext.runAsNonRoot' to true",
      ],
      description: 'Force the running image to run as a non-root user.',
    });
  });

  test('a namespace filter narrows coverage', async () => {
    const p = await (await srv.authed('/api/security/progress?namespace=other')).json();
    assert.deepEqual(p.coverage, { images: 0, scanned: 0, notScanned: 0, scanning: 0, failed: 0 });
  });
});
