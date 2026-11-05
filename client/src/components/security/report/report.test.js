// The downloadable vulnerability report: what it contains, that environment
// identifiers are masked, that nothing in it can run, and the CSV's safety.
import { describe, it, expect } from 'vitest';
import { buildReportModel, reportFileName, safeLink } from './model';
import { reportHtml, formatWhen } from './html';
import { reportCsv, checksCsv, csvCell } from './csv';
import { buildChecksModel, checksFileName, checksHtml, checksKindOf } from './checks';

/** No product name or logo in any report. */
const NO_BRAND = /K8Board|KubePilot|K<span|<img/i;

const ECR = '241533118296.dkr.ecr.eu-west-1.amazonaws.com';
const GENERATED = new Date('2026-11-05T09:02:00Z');

const IMAGE = {
  image: `${ECR}/bo-backend:release-359`, repository: 'bo-backend', tag: 'release-359',
  digest: 'sha256:10a3892210c19396c3c32f52100ea1fb70af0fa28688070131275861893', os: 'alpine 3.20.3',
  namespace: 'uat', status: 'Scanned', active: true, scanner: 'Trivy 0.58.1', scannedAt: '2026-11-04T18:20:00Z',
  workloads: [{ kind: 'ReplicaSet', name: 'uat-cashier-dep-8565fb6d9c', namespace: 'uat', container: 'app', running: true }],
  secrets: 1,
  secretsList: [{ ruleID: 'aws-access-key-id', title: 'AWS Access Key', severity: 'CRITICAL', target: '/app/config/application.yml', line: 12 }],
  vulnerabilities: [
    { id: 'CVE-2025-24813', severity: 'CRITICAL', pkg: 'org.apache.tomcat.embed:tomcat-embed-core', installedVersion: '10.1.55', fixedVersion: '10.1.59', title: 'Tomcat partial PUT RCE', link: 'https://avd.aquasec.com/nvd/cve-2025-24813', score: 9.8, class: 'lang-pkgs', packageType: 'jar', packagePath: 'app/app.jar' },
    { id: 'CVE-2024-0001', severity: 'MEDIUM', pkg: 'libexpat', installedVersion: '2.8.2-r0', fixedVersion: '', title: 'expat <b>bug</b>', link: 'javascript:alert(1)', score: 5.3, class: 'os-pkgs', packageType: 'alpine', target: `${ECR}/bo-backend:release-359 (alpine 3.20.3)` },
    { id: 'CVE-2025-1111', severity: 'HIGH', pkg: 'io.netty:netty-handler', installedVersion: '4.2.11.Final', fixedVersion: '4.1.137.Final, 4.2.12.Final', title: '=HYPERLINK("http://evil")', score: 7.5, class: 'lang-pkgs', packageType: 'jar', packagePath: 'app/app.jar' },
    // the same finding reported twice (two workloads) is one finding
    { id: 'CVE-2025-1111', severity: 'HIGH', pkg: 'io.netty:netty-handler', installedVersion: '4.2.11.Final', fixedVersion: '4.2.12.Final', score: 7.5 },
  ],
  remediation: {
    total: 3, fixable: 2, noFix: 1, osFixes: 0, appFixes: 2,
    upgrades: [
      { pkg: 'org.apache.tomcat.embed:tomcat-embed-core', installedVersion: '10.1.55', upgradeTo: '10.1.59', class: 'lang-pkgs', packageType: 'jar', packagePath: 'app/app.jar', cves: 1, worst: 'CRITICAL', bySeverity: { CRITICAL: 1 } },
      { pkg: 'io.netty:netty-handler', installedVersion: '4.2.11.Final', upgradeTo: '4.2.12.Final', class: 'lang-pkgs', packageType: 'jar', packagePath: 'app/app.jar', cves: 1, worst: 'HIGH', bySeverity: { HIGH: 1 } },
    ],
  },
};
const DETAILS = {
  source: 'operator', available: true,
  details: [{
    id: 'CVE-2025-24813', pkg: 'org.apache.tomcat.embed:tomcat-embed-core', installedVersion: '10.1.55',
    description: 'Path equivalence in partial PUT can lead to remote code execution.\nSee the advisory.', publishedDate: '2025-03-10T17:15:00Z', lastModifiedDate: '2025-04-01T00:00:00Z',
    cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', cvssSource: 'nvd',
    links: ['https://avd.aquasec.com/nvd/cve-2025-24813', 'https://lists.apache.org/thread/abc'],
  }],
};
const CONTEXT = 'arn:aws:eks:eu-west-1:241533118296:cluster/uat';

const model = (over = {}) => buildReportModel(IMAGE, { context: CONTEXT, details: DETAILS, generatedAt: GENERATED, ...over });

describe('report model', () => {
  it('orders findings worst first, counts what it lists, and deduplicates', () => {
    const m = model();
    expect(m.findings.map((f) => f.id)).toEqual(['CVE-2025-24813', 'CVE-2025-1111', 'CVE-2024-0001']);
    expect(m.counts).toEqual({ CRITICAL: 1, HIGH: 1, MEDIUM: 1, LOW: 0, UNKNOWN: 0 });
    expect([m.total, m.risk, m.fix.fixable, m.fix.noFix, m.fix.keyTotal, m.fix.keyFixable]).toEqual([3, 'CRITICAL', 2, 1, 2, 2]);
    expect([m.fix.osFindings, m.fix.appFindings]).toEqual([1, 2]);
    expect(m.keyFindings.map((f) => f.id)).toEqual(['CVE-2025-24813', 'CVE-2025-1111']);
  });

  it('merges the advisory details by finding', () => {
    const tomcat = model().findings[0];
    expect(tomcat.description).toMatch(/^Path equivalence/);
    expect(tomcat.cvssVector).toBe('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H');
    expect(tomcat.links).toEqual(['https://avd.aquasec.com/nvd/cve-2025-24813', 'https://lists.apache.org/thread/abc']);
    expect(model().detailsAvailable).toBe(true);
    expect(model({ details: null }).detailsAvailable).toBe(false);
  });

  it('masks the account id in the image, registry, cluster ARN and package locations', () => {
    const m = model();
    expect(m.image.ref).toBe('••••8296.dkr.ecr.eu-west-1.amazonaws.com/bo-backend:release-359');
    expect(m.image.location).toBe('••••8296.dkr.ecr.eu-west-1.amazonaws.com');
    expect(m.image.context).toBe('arn:aws:eks:eu-west-1:••••8296:cluster/uat');
    expect(JSON.stringify(m)).not.toContain('241533118296');
  });

  it('keeps only http(s) links', () => {
    expect(model().findings.find((f) => f.id === 'CVE-2024-0001').link).toBe('');
    expect(safeLink('https://nvd.nist.gov/vuln/detail/CVE-1')).toBe('https://nvd.nist.gov/vuln/detail/CVE-1');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'https://x"onmouseover=1', null]) expect(safeLink(bad)).toBe('');
  });

  it('builds the remediation from the details response when the image has none (built-in scans)', () => {
    const m = buildReportModel({ ...IMAGE, remediation: undefined }, { details: { ...DETAILS, remediation: IMAGE.remediation }, generatedAt: GENERATED });
    expect(m.upgrades.map((u) => u.pkg)).toEqual(['org.apache.tomcat.embed:tomcat-embed-core', 'io.netty:netty-handler']);
  });

  it('names the file after the image name and tag, never the registry', () => {
    const m = model();
    expect(reportFileName(m, 'pdf')).toMatch(/^vulnerability-report_bo-backend_release-359_\d{4}-\d{2}-\d{2}\.pdf$/);
    const byDigest = buildReportModel({ image: 'nginx@sha256:abcdef0123456789abcd', repository: 'nginx', digest: 'sha256:abcdef0123456789abcd', vulnerabilities: [] }, { generatedAt: GENERATED });
    expect(reportFileName(byDigest, 'csv')).toMatch(/^vulnerability-report_nginx_abcdef012345_\d{4}-\d{2}-\d{2}\.csv$/);
  });
});

describe('HTML report', () => {
  const html = reportHtml(model());

  it('is a self-contained document that cannot run or load anything', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son\w+=/i);
    expect(html).not.toContain('javascript:');
  });

  it('carries no product name or logo', () => {
    expect(html).not.toMatch(NO_BRAND);
    expect(html).toContain('<div class="doc-type">Vulnerability report</div>');
    expect(reportHtml(model({ details: { ...DETAILS, source: 'builtin' } }))).not.toMatch(NO_BRAND);
  });

  it('escapes every value', () => {
    expect(html).toContain('expat &lt;b&gt;bug&lt;/b&gt;');
    expect(html).not.toContain('<b>bug</b>');
    expect(html).toContain('=HYPERLINK(&quot;http://evil&quot;)');
  });

  it('has every section, in order, with the summary and the full upgrade list', () => {
    const titles = [...html.matchAll(/<h2><span class="num-label">([^<]+)<\/span>([^<]+)<\/h2>/g)].map((x) => `${x[1]} ${x[2]}`);
    expect(titles).toEqual([
      '1. Executive summary', '2. Image details', '3. Recommended actions', '4. Critical and high findings',
      '5. All findings (3)', '6. Exposed secrets', 'A. Appendix',
    ]);
    expect(html).toContain('This image has <strong>3 known vulnerabilities</strong>: 1 critical, 1 high and 1 medium.');
    expect(html).toContain('<strong>2 of them (67%)</strong> have a fixed version available, including <strong>2 of 2</strong> critical and high.');
    expect(html).toContain('Upgrading 2 packages resolves every finding that has a fix.');
    expect(html).toContain('Overall: Critical risk');
    expect(html).toContain('Remove and rotate exposed secrets.');
    expect(html).toContain('Path equivalence in partial PUT can lead to remote code execution.');
    expect(html).toContain('<a href="https://lists.apache.org/thread/abc">');
    expect(html).toContain('/app/config/application.yml:12');
    expect(html).toContain('2026-11-05 09:02 UTC');
  });

  it('shows the masked identifiers only', () => {
    expect(html).not.toContain('241533118296');
    expect(html).toContain('arn:aws:eks:eu-west-1:••••8296:cluster/uat');
  });

  it('says when advisory text is missing, and when there is nothing to fix', () => {
    expect(reportHtml(model({ details: null }))).toContain('Advisory descriptions were not available for this scan');
    const clean = reportHtml(buildReportModel({ ...IMAGE, vulnerabilities: [], remediation: null, secrets: 0, secretsList: [] }, { generatedAt: GENERATED }));
    expect(clean).toContain('No known vulnerabilities were found in this image when it was scanned.');
    expect(clean).toContain('Overall: No known vulnerabilities');
    expect(clean).not.toContain('Exposed secrets');
  });

  it('formats times with UTC beside local time', () => {
    expect(formatWhen('2026-11-05T09:02:00Z')).toMatch(/^\d{1,2} \w+ 2026, \d{2}:\d{2} \(2026-11-05 09:02 UTC\)$/);
    expect(formatWhen('not a date')).toBe('');
  });
});

// ------------------------------------------------------------ checks --

const DEPLOYMENT = {
  kind: 'Deployment', name: 'payments', namespace: 'shop', createdAt: '2026-10-01T08:00:00Z', scannedAt: '2026-11-04T18:20:00Z',
  scanner: 'Trivy 0.58.1', labels: 3, summary: { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 0, UNKNOWN: 0 },
  checks: [
    { id: 'KSV018', title: 'No memory limit set', severity: 'MEDIUM', category: 'Kubernetes Security Check', message: "Container 'api' should set 'resources.limits.memory'", remediation: 'Set resources.limits.memory' },
    { id: 'KSV012', title: 'Runs as root <user>', severity: 'HIGH', category: 'Kubernetes Security Check', remediation: 'Set securityContext.runAsNonRoot: true',
      description: 'Run the container as a non-root user.',
      messages: ["Container 'api' should set runAsNonRoot", "Container 'proxy' pulls from 241533118296.dkr.ecr.eu-west-1.amazonaws.com/proxy:1"] },
    { id: 'KSV020', title: 'Runs with a low user ID', severity: 'MEDIUM', category: 'Best Practice', message: 'Run with UID > 10000', remediation: '=cmd|calc' },
    // reported twice: one finding
    { id: 'KSV020', title: 'Runs with a low user ID', severity: 'MEDIUM', category: 'Best Practice', message: 'Run with UID > 10000', remediation: '=cmd|calc' },
  ],
};
const ROLE = {
  kind: 'ClusterRole', name: 'shop-deployer', namespace: '', scannedAt: '2026-11-04T18:20:00Z', summary: { CRITICAL: 1 },
  checks: [{ id: 'KSV046', title: 'Manage all resources', severity: 'CRITICAL', category: 'Kubernetes Security Check', message: 'ClusterRole grants * on *', remediation: 'Grant only what is needed' }],
};
const checksModel = (r = DEPLOYMENT, over = {}) => buildChecksModel(r, { context: CONTEXT, generatedAt: GENERATED, ...over });

describe('resource checks report', () => {
  it('orders the failed checks worst first, deduplicates, and counts what it lists', () => {
    const m = checksModel();
    expect(m.checks.map((c) => c.id)).toEqual(['KSV012', 'KSV018', 'KSV020']);
    expect(m.counts).toEqual({ CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 0, UNKNOWN: 0 });
    expect([m.total, m.risk, m.type, m.keyChecks.length]).toEqual([3, 'HIGH', 'config', 1]);
    expect(m.categories).toEqual([{ name: 'Kubernetes Security Check', count: 2 }, { name: 'Best Practice', count: 1 }]);
  });

  it('keeps every message, masking environment identifiers in them and in the cluster name', () => {
    const m = checksModel();
    expect(m.checks[0].messages).toEqual(["Container 'api' should set runAsNonRoot", "Container 'proxy' pulls from ••••8296.dkr.ecr.eu-west-1.amazonaws.com/proxy:1"]);
    expect(m.checks[1].messages).toEqual(["Container 'api' should set 'resources.limits.memory'"]);
    expect(m.resource.context).toBe('arn:aws:eks:eu-west-1:••••8296:cluster/uat');
    expect(JSON.stringify(m)).not.toContain('241533118296');
  });

  it('tells RBAC findings from configuration audit ones', () => {
    expect(checksKindOf(ROLE)).toBe('rbac');
    expect(checksKindOf(DEPLOYMENT)).toBe('config');
    expect(checksKindOf(DEPLOYMENT, 'rbac')).toBe('rbac');
    const html = checksHtml(checksModel(ROLE));
    expect(html).toContain('<div class="doc-type">RBAC assessment report</div>');
    expect(html).toContain('<h2><span class="num-label">2.</span>Role details</h2>');
    expect(html).toContain('<span class="dim">Cluster-wide</span>');
    expect(html).toContain('RbacAssessmentReport');
  });

  it('the HTML: every section, escaped, nothing that runs, no product name', () => {
    const html = checksHtml(checksModel());
    const titles = [...html.matchAll(/<h2><span class="num-label">([^<]+)<\/span>([^<]+)<\/h2>/g)].map((x) => `${x[1]} ${x[2]}`);
    expect(titles).toEqual(['1. Executive summary', '2. Resource details', '3. Recommended actions', '4. Critical and high findings', '5. All failed checks (3)', 'A. Appendix']);
    expect(html).toContain('<div class="doc-type">Configuration audit report</div>');
    expect(html).toContain('Deployment <strong>payments</strong> in namespace <strong>shop</strong> fails <strong>3 security checks</strong>: 1 high and 2 medium.');
    expect(html).toContain('By category: 2 Kubernetes Security Check and 1 Best Practice.');
    expect(html).toContain('Runs as root &lt;user&gt;');
    expect(html).toContain('<div class="fix"><strong>How to fix:</strong> Set securityContext.runAsNonRoot: true</div>');
    expect(html).toContain('ConfigAuditReport');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(NO_BRAND);
    expect(html).not.toContain('241533118296');
  });

  it('a resource with no failed checks says so', () => {
    const html = checksHtml(checksModel({ ...DEPLOYMENT, checks: [] }));
    expect(html).toContain('passes every check that was run.');
    expect(html).toContain('Overall: No failed checks');
  });

  it('the CSV: one row per failed check, formulas escaped', () => {
    const csv = checksCsv(checksModel());
    const rows = csv.replace(/^\ufeff/, '').trimEnd().split('\r\n');
    expect(rows).toHaveLength(4);
    expect(rows[0]).toBe('"Check ID","Severity","Title","Category","Finding","How to fix","Description","Kind","Name","Namespace","Cluster","Checked"');
    expect(rows[1]).toContain('"KSV012","High","Runs as root <user>"');
    expect(rows[3]).toContain('"\'=cmd|calc"');
    expect(csv).not.toContain('241533118296');
  });

  it('file names: report type, namespace, kind and name', () => {
    expect(checksFileName(checksModel(), 'pdf')).toMatch(/^config-audit-report_shop_deployment-payments_\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(checksFileName(checksModel(ROLE), 'csv')).toMatch(/^rbac-assessment-report_clusterrole-shop-deployer_\d{4}-\d{2}-\d{2}\.csv$/);
  });
});

describe('CSV report', () => {
  const csv = reportCsv(model());
  const rows = csv.replace(/^\ufeff/, '').trimEnd().split('\r\n');

  it('one row per finding, with a BOM and a header', () => {
    expect(csv.startsWith('\ufeff')).toBe(true);
    expect(rows).toHaveLength(4);
    expect(rows[0].startsWith('"Vulnerability ID","Severity","CVSS score","CVSS vector","Package"')).toBe(true);
    expect(rows[1].startsWith('"CVE-2025-24813","Critical","9.8","CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H","org.apache.tomcat.embed:tomcat-embed-core","10.1.55","10.1.59","Yes"')).toBe(true);
    expect(csv).not.toContain('241533118296');
  });

  it('cannot inject spreadsheet formulas', () => {
    expect(rows[2]).toContain('"\'=HYPERLINK(""http://evil"")"');
    for (const s of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx']) expect(csvCell(s).startsWith('"\'')).toBe(true);
    expect(csvCell('CVE-1')).toBe('"CVE-1"');
    expect(csvCell('a "quoted" value')).toBe('"a ""quoted"" value"');
  });
});
