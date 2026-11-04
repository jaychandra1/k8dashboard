// Security Center insight helpers (lib/security-insights.mjs): scan coverage
// per (workload, container), remediation (what to upgrade), and scan failure
// reasons + hints from the operator's log.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  scanUnits, reportTarget, scanCoverage, compareLooseVersions, pickFixedVersion, remediationFor, operatorLogErrors, failureHints, scannerFailure,
  runningReportCheck, revisionChanges, severityCounts,
} from '../lib/security-insights.mjs';

const pod = (ns, name, owner, containers, { init = [], phase = 'Running', statuses = [] } = {}) => ({
  metadata: { namespace: ns, name, ownerReferences: owner ? [{ kind: owner[0], name: owner[1], controller: true }] : [] },
  spec: { containers: containers.map(([n, image]) => ({ name: n, image })), initContainers: init.map(([n, image]) => ({ name: n, image })) },
  status: { phase, containerStatuses: statuses },
});
const report = (ns, kind, name, container, digest = '') => ({
  metadata: { namespace: ns, labels: { 'trivy-operator.resource.kind': kind, 'trivy-operator.resource.name': name, 'trivy-operator.resource.namespace': ns, 'trivy-operator.container.name': container } },
  report: { artifact: { digest } },
});

describe('scan coverage', () => {
  const pods = [
    pod('shop', 'web-1', ['ReplicaSet', 'web-7f9'], [['app', 'acme/web:1.2']], { init: [['migrate', 'acme/migrate:1.2']] }),
    pod('shop', 'web-2', ['ReplicaSet', 'web-7f9'], [['app', 'acme/web:1.2']], { init: [['migrate', 'acme/migrate:1.2']] }),
    pod('shop', 'db-0', ['StatefulSet', 'db'], [['pg', 'postgres:16']]),
    pod('ops', 'backup-28000000-x', ['Job', 'backup-28000000'], [['run', 'acme/backup:3']]),
    pod('ops', 'done', ['Job', 'old'], [['run', 'acme/old:1']], { phase: 'Succeeded' }),
    pod('edge', 'proxy', null, [['envoy', 'envoyproxy/envoy:v1.30']], { statuses: [{ name: 'envoy', imageID: 'docker.io/envoyproxy/envoy@sha256:abc123' }] }),
  ];

  test('one unit per (workload, container): replicas share it, init containers count, finished pods do not', () => {
    const units = scanUnits(pods);
    assert.deepEqual(units.map((u) => `${u.namespace}/${u.kind}/${u.name}/${u.container}`).sort(), [
      'edge/Pod/proxy/envoy', 'ops/Job/backup-28000000/run', 'shop/ReplicaSet/web-7f9/app', 'shop/ReplicaSet/web-7f9/migrate', 'shop/StatefulSet/db/pg',
    ]);
  });

  test('matched by workload + container, by CronJob for its jobs, or by digest; the rest by job state', () => {
    const units = scanUnits(pods);
    const reports = [
      report('shop', 'ReplicaSet', 'web-7f9', 'app'),
      report('ops', 'CronJob', 'backup', 'run'),
      report('other', 'Pod', 'x', 'y', 'sha256:abc123'), // same image digest as the envoy pod
    ];
    const jobs = [
      { target: reportTarget({ metadata: { namespace: 'trivy-system', labels: { 'trivy-operator.resource.kind': 'StatefulSet', 'trivy-operator.resource.name': 'db', 'trivy-operator.resource.namespace': 'shop', 'trivy-operator.container.name': 'pg' } } }), active: true, failed: false },
    ];
    const cov = scanCoverage(units, reports, jobs);
    assert.equal(cov.images, 5);
    assert.equal(cov.scanned, 3); // web, backup (via CronJob), envoy (via digest)
    assert.equal(cov.notScanned, 2);
    const byImage = Object.fromEntries(cov.pending.map((p) => [p.image, p.status]));
    assert.deepEqual(byImage, { 'acme/migrate:1.2': 'Not Scanned', 'postgres:16': 'Scanning' });
    const failed = scanCoverage(units, reports, [{ ...jobs[0], active: false, failed: true }]);
    assert.equal(failed.pending.find((p) => p.image === 'postgres:16').status, 'Failed');
    assert.deepEqual(failed.pending.find((p) => p.image === 'postgres:16').workloads, [{ kind: 'StatefulSet', name: 'db', namespace: 'shop', container: 'pg' }]);
  });
});

describe('running images & what a rollout fixed', () => {
  // Deployment web: revision 3 runs (web-new), 2 (web-cfg) was a config-only
  // rollout of the same image as 1 (web-old) — both kept for rollback.
  const rsReport = (name, image, vulns, digest = '') => ({
    ...report('shop', 'ReplicaSet', name, 'app', digest),
    report: { artifact: { repository: image.split(':')[0], tag: image.split(':')[1], digest }, vulnerabilities: vulns },
  });
  const v = (id, severity, pkg = 'openssl') => ({ vulnerabilityID: id, severity, resource: pkg });
  const NEW = rsReport('web-new', 'acme/web:1.3', [v('CVE-1', 'HIGH'), v('CVE-9', 'CRITICAL', 'curl')], 'sha256:new');
  const CFG = rsReport('web-cfg', 'acme/web:1.2', [v('CVE-1', 'HIGH'), v('CVE-2', 'CRITICAL'), v('CVE-3', 'MEDIUM')], 'sha256:old');
  const OLD = rsReport('web-old', 'acme/web:1.2', [v('CVE-1', 'HIGH'), v('CVE-2', 'CRITICAL'), v('CVE-3', 'MEDIUM')], 'sha256:old');
  const replicaSets = [
    { namespace: 'shop', name: 'web-new', deployment: 'web', revision: 3 },
    { namespace: 'shop', name: 'web-cfg', deployment: 'web', revision: 2 },
    { namespace: 'shop', name: 'web-old', deployment: 'web', revision: 1 },
  ];
  const opts = {
    vulnsOf: (r) => r.report.vulnerabilities.map((x) => ({ id: x.vulnerabilityID, severity: x.severity, pkg: x.resource })),
    imageOf: (r) => `${r.report.artifact.repository}:${r.report.artifact.tag}`,
  };

  test('a report counts while its workload (or its image digest) runs; old ReplicaSets do not', () => {
    const units = scanUnits([
      pod('shop', 'web-1', ['ReplicaSet', 'web-new'], [['app', 'acme/web:1.3']]),
      pod('edge', 'x', null, [['app', 'acme/web:1.2']], { statuses: [{ name: 'app', imageID: 'acme/web@sha256:old' }] }),
    ]);
    const running = runningReportCheck(units);
    assert.equal(running(NEW), true);
    assert.equal(running(OLD), true, 'its digest still runs elsewhere');
    assert.equal(runningReportCheck(scanUnits([pod('shop', 'web-1', ['ReplicaSet', 'web-new'], [['app', 'acme/web:1.3']])]))(OLD), false);
  });

  test('the newest revision vs the previous image (skipping a config-only rollout): fixed and introduced', () => {
    const changes = revisionChanges([OLD, CFG, NEW], replicaSets, opts);
    assert.equal(changes.size, 1, 'only the newest revision of each Deployment + container');
    const c = changes.get(NEW);
    assert.deepEqual(
      { ...c, resolved: c.resolved.map((x) => x.id), introduced: c.introduced.map((x) => x.id) },
      { workload: 'Deployment web', container: 'app', revision: 3, previousRevision: 2, previousImage: 'acme/web:1.2', resolved: ['CVE-2', 'CVE-3'], introduced: ['CVE-9'] },
    );
    // Same image in the last two revisions and nothing older: nothing to compare.
    assert.equal(revisionChanges([OLD, CFG], replicaSets, opts).size, 0);
    // Reports of other kinds, or of ReplicaSets without a Deployment, are ignored.
    assert.equal(revisionChanges([report('shop', 'StatefulSet', 'db', 'pg')], replicaSets, opts).size, 0);
  });

  test('severity counts', () => {
    assert.deepEqual(severityCounts([{ severity: 'CRITICAL' }, { severity: 'HIGH' }, { severity: 'HIGH' }, { severity: 'weird' }]), { CRITICAL: 1, HIGH: 2, MEDIUM: 0, LOW: 0, UNKNOWN: 1 });
  });
});

describe('remediation', () => {
  test('versions compare numerically; the fix on the installed major line wins', () => {
    assert.ok(compareLooseVersions('1.10.0', '1.9.9') > 0);
    assert.ok(compareLooseVersions('3.0.12-r0', '3.0.8-r0') > 0);
    assert.equal(compareLooseVersions('1.2', '1.2'), 0);
    assert.ok(compareLooseVersions('1.2', '1.2.1') < 0);
    assert.equal(pickFixedVersion('1.2.4, 2.0.1', '1.1.0'), '1.2.4');
    assert.equal(pickFixedVersion('2.0.1, 1.2.4', '2.0.0'), '2.0.1');
    assert.equal(pickFixedVersion('0.9.1, 0.8.7', '3.0.0'), '0.8.7', 'no same-line fix → the lowest');
    assert.equal(pickFixedVersion('', '1.0'), '');
  });

  test('one upgrade per package to the highest needed version, worst first; OS vs app fixes counted', () => {
    const vulns = [
      { id: 'CVE-1', severity: 'HIGH', pkg: 'openssl', installedVersion: '3.0.8-r0', fixedVersion: '3.0.9-r0', class: 'os-pkgs' },
      { id: 'CVE-2', severity: 'CRITICAL', pkg: 'openssl', installedVersion: '3.0.8-r0', fixedVersion: '3.0.12-r0', class: 'os-pkgs' },
      { id: 'CVE-3', severity: 'CRITICAL', pkg: 'golang.org/x/net', installedVersion: 'v0.7.0', fixedVersion: '0.17.0', class: 'lang-pkgs', packagePath: 'usr/bin/app' },
      { id: 'CVE-4', severity: 'MEDIUM', pkg: 'zlib', installedVersion: '1.2.13', fixedVersion: '', class: 'os-pkgs' },
      { id: 'CVE-5', severity: 'LOW', pkg: 'busybox', installedVersion: '1.36.0', fixedVersion: '1.36.1', class: 'os-pkgs' },
    ];
    const r = remediationFor(vulns);
    assert.equal(r.total, 5);
    assert.equal(r.fixable, 4);
    assert.equal(r.noFix, 1);
    assert.equal(r.osFixes, 3);
    assert.equal(r.appFixes, 1);
    assert.equal(r.fixableBySeverity.CRITICAL, 2);
    assert.deepEqual(r.upgrades.map((u) => [u.pkg, u.upgradeTo, u.cves, u.worst]), [
      ['openssl', '3.0.12-r0', 2, 'CRITICAL'], // two CVEs: sorts before the single-CVE critical
      ['golang.org/x/net', '0.17.0', 1, 'CRITICAL'],
      ['busybox', '1.36.1', 1, 'LOW'],
    ]);
    assert.equal(r.upgrades[1].packagePath, 'usr/bin/app');
    assert.deepEqual(r.upgrades[0].bySeverity, { CRITICAL: 1, HIGH: 1, MEDIUM: 0, LOW: 0, UNKNOWN: 0 });
    assert.equal(remediationFor([]).total, 0);
  });
});

describe('scan failures', () => {
  test('operator log: error lines only, the scanner\'s message included, deduplicated, newest kept', () => {
    const log = [
      JSON.stringify({ level: 'info', msg: 'Reconciling', job: 'trivy-system/scan-vulnerabilityreport-aaa' }),
      JSON.stringify({ level: 'error', msg: 'Scan job container', job: 'trivy-system/scan-vulnerabilityreport-aaa', 'status.message': '2026-10-23T10:00:00Z FATAL image scan error: unable to inspect the image (123456789012.dkr.ecr.eu-west-1.amazonaws.com/app:1): GET https://...: unexpected status code 401 Unauthorized: Not Authorized' }),
      JSON.stringify({ level: 'error', msg: 'Scan job container', job: 'trivy-system/scan-vulnerabilityreport-bbb', 'status.message': '2026-10-23T10:00:00Z FATAL image scan error: unable to inspect the image (123456789012.dkr.ecr.eu-west-1.amazonaws.com/app:1): GET https://...: unexpected status code 401 Unauthorized: Not Authorized' }),
      'not json at all',
      JSON.stringify({ level: 'error', msg: 'Reconciler error', error: 'context deadline exceeded' }),
    ].join('\n');
    const errors = operatorLogErrors(log);
    assert.equal(errors.length, 2, JSON.stringify(errors));
    assert.match(errors[0], /^Scan job container — .*401 Unauthorized/);
    assert.match(errors[1], /context deadline exceeded/);
    assert.equal(operatorLogErrors(Array.from({ length: 10 }, (_, i) => JSON.stringify({ level: 'error', msg: `boom ${'x'.repeat(i + 1)}` })).join('\n')).length, 6);
  });

  test("a failed scan shows the scanner's FATAL line, not its INFO preamble; repeats and routine errors are dropped", () => {
    const output = (ts) => [
      `${ts} INFO Adding schema version to the DB repository for backward compatibility repository="mirror.gcr.io/aquasec/trivy-java-db:1"`,
      `${ts} WARN "--slow" is deprecated. Use "--parallel 1" instead.`,
      `${ts} INFO [image] Container image config scanners scanners=[secret]`,
      `${ts} INFO [vuln] Vulnerability scanning is enabled`,
      `${ts} FATAL Fatal error run error: image scan error: scan error: unable to initialize a scan service: unable to initialize an image scan service: unable to find the specified image "123456789012.dkr.ecr.eu-west-1.amazonaws.com/api:7" in ["remote"]: remote error: GET https://123456789012.dkr.ecr.eu-west-1.amazonaws.com/v2/api/manifests/7: unexpected status code 401 Unauthorized: Not Authorized`,
    ].join(' ');
    const log = [
      JSON.stringify({ level: 'error', msg: 'Scan job container', 'status.message': output('2026-10-29T08:16:18Z') }),
      JSON.stringify({ level: 'error', msg: 'Reconciler error', error: 'failed marking old reports for immediate deletion : configauditreports.aquasecurity.github.io "replicaset-qa-master-integration-7f6bf884c4" not found' }),
      JSON.stringify({ level: 'error', msg: 'Scan job container', 'status.message': output('2026-10-29T08:17:36Z') }),
      JSON.stringify({ level: 'error', msg: 'Scan job container', 'status.message': output('2026-10-29T08:18:00Z') }),
    ].join('\n');
    const errors = operatorLogErrors(log);
    assert.equal(errors.length, 1, JSON.stringify(errors, null, 1));
    assert.match(errors[0], /^Scan job container — FATAL Fatal error run error: image scan error: .*401 Unauthorized: Not Authorized$/);
    assert.doesNotMatch(errors[0], /INFO|WARN|2026-10-29/);
    assert.deepEqual(failureHints(errors).map((h) => h.id), ['registry']);
    // No FATAL/ERROR line: the last entry is kept.
    assert.equal(scannerFailure('2026-10-29T08:16:18Z INFO starting 2026-10-29T08:16:19Z INFO still going'), 'INFO still going');
    assert.equal(scannerFailure('2026-10-29T08:16:18Z INFO a 2026-10-29T08:16:20Z ERROR boom 2026-10-29T08:16:21Z INFO cleanup'), 'ERROR boom');
  });

  test('hints for the common causes — and none for unrelated text', () => {
    const ids = (msgs) => failureHints(msgs).map((h) => h.id);
    assert.deepEqual(ids(['unexpected status code 401 Unauthorized']), ['registry']);
    assert.deepEqual(ids(['no basic auth credentials']), ['registry']);
    assert.deepEqual(ids(['Scan pod OOMKilled']), ['memory']);
    assert.deepEqual(ids(['Job was active longer than specified deadline: DeadlineExceeded']), ['timeout']);
    assert.deepEqual(ids(['pods "scan-x" is forbidden: exceeded quota: compute']), ['capacity']);
    assert.deepEqual(ids(['Scan pod not scheduled: 0/3 nodes are available: 3 Insufficient memory']), ['capacity']);
    assert.deepEqual(ids(['failed to download vulnerability DB']), ['database']);
    assert.deepEqual(ids(['FATAL ... write /tmp/fanal-layers: no space left on device']), ['disk']);
    assert.deepEqual(ids(['FATAL ... MANIFEST_UNKNOWN: manifest unknown']), ['image-missing']);
    assert.deepEqual(ids(['scanning mongodb:7 in namespace ecr-tools']), []);
  });
});
