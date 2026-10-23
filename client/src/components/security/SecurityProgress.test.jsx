import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OperatorBanner } from './ScanPanel';
import Remediation from './Remediation';
import VulnTable from './VulnTable';

const op = { found: true, namespace: 'trivy-system', name: 'trivy-operator', ready: 1, desired: 1, version: '0.24.1', concurrency: 3 };

describe('OperatorBanner — what the Trivy Operator is doing', () => {
  it('scanning: scans in flight, coverage with a progress bar, last report', () => {
    render(<OperatorBanner progress={{ operator: op, scanning: true, jobs: { active: 2, failed: 0 }, coverage: { images: 32, scanned: 8, notScanned: 24 }, lastReportAt: new Date(Date.now() - 120000).toISOString(), failures: [], hints: [] }} onRefresh={() => {}} />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('Trivy Operator is scanning · 2 scans running · 8 of 32 images scanned');
    expect(banner).toHaveTextContent(/last report/);
    expect(banner).toHaveTextContent('up to 3 at a time');
    expect(screen.getByRole('progressbar', { name: 'Images scanned' })).toHaveAttribute('aria-valuenow', '25');
  });

  it('stalled with failures: says so, shows what to do and the errors with identifiers masked', async () => {
    const onNavigate = vi.fn();
    render(<OperatorBanner
      progress={{
        operator: op, scanning: false, jobs: { active: 0, failed: 3 },
        coverage: { images: 32, scanned: 3, notScanned: 29, failed: 3 }, lastReportAt: '',
        failures: ['Scan job container — unable to inspect the image (241533118296.dkr.ecr.eu-west-1.amazonaws.com/api:7): 401 Unauthorized'],
        hints: [{ id: 'registry', text: 'Scan jobs could not pull private images. Give the Trivy Operator read access to your registry.' }],
      }}
      onRefresh={() => {}}
      onNavigate={onNavigate}
    />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('29 of 32 running images aren’t scanned yet, and no scans are running (3 failed)');
    expect(banner).toHaveTextContent('What to do: Scan jobs could not pull private images.');
    expect(banner).toHaveTextContent('Recent scan errors (1)');
    expect(banner).toHaveTextContent('401 Unauthorized');
    expect(banner.textContent).not.toContain('241533118296');
    await userEvent.setup().click(screen.getByRole('button', { name: /Open the operator's pods/ }));
    expect(onNavigate).toHaveBeenCalled();
  });

  it('operator down, and all done', () => {
    const { rerender } = render(<OperatorBanner progress={{ operator: { ...op, ready: 0 }, scanning: false, jobs: { active: 0 }, coverage: { images: 5, scanned: 2, notScanned: 3 }, failures: [], hints: [] }} onRefresh={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent('The Trivy Operator isn’t running (0/1 ready)');
    rerender(<OperatorBanner progress={{ operator: op, scanning: false, jobs: { active: 0 }, coverage: { images: 5, scanned: 5, notScanned: 0 }, failures: [], hints: [] }} onRefresh={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent('All 5 running images are scanned');
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});

const IMAGE = {
  image: 'registry.k8s.io/ingress-nginx/controller:v1.7.0', repository: 'ingress-nginx/controller', tag: 'v1.7.0', os: 'alpine 3.17.3', namespace: 'ingress-nginx',
  summary: { CRITICAL: 2, HIGH: 1, MEDIUM: 1, LOW: 0, UNKNOWN: 0 },
  vulnerabilities: [
    { id: 'CVE-1', severity: 'CRITICAL', pkg: 'libcrypto3', installedVersion: '3.0.8-r3', fixedVersion: '3.0.12-r1', class: 'os-pkgs' },
    { id: 'CVE-2', severity: 'CRITICAL', pkg: 'golang.org/x/net', installedVersion: 'v0.7.0', fixedVersion: '0.17.0', class: 'lang-pkgs' },
    { id: 'CVE-3', severity: 'HIGH', pkg: 'libcrypto3', installedVersion: '3.0.8-r3', fixedVersion: '3.0.9-r0', class: 'os-pkgs' },
    { id: 'CVE-4', severity: 'MEDIUM', pkg: 'zlib', installedVersion: '1.2.13', fixedVersion: '', class: 'os-pkgs' },
  ],
  remediation: {
    total: 4, fixable: 3, noFix: 1, osFixes: 2, appFixes: 1,
    fixableBySeverity: { CRITICAL: 2, HIGH: 1, MEDIUM: 0, LOW: 0, UNKNOWN: 0 },
    upgrades: [
      { pkg: 'libcrypto3', installedVersion: '3.0.8-r3', upgradeTo: '3.0.12-r1', class: 'os-pkgs', cves: 2, worst: 'CRITICAL', bySeverity: { CRITICAL: 1, HIGH: 1, MEDIUM: 0, LOW: 0, UNKNOWN: 0 } },
      { pkg: 'golang.org/x/net', installedVersion: 'v0.7.0', upgradeTo: '0.17.0', class: 'lang-pkgs', packagePath: 'nginx-ingress-controller', cves: 1, worst: 'CRITICAL', bySeverity: { CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 } },
    ],
  },
  workloads: [{ kind: 'ReplicaSet', name: 'ingress-nginx-controller-5d', namespace: 'ingress-nginx' }],
  status: 'Scanned', scannedAt: '2026-10-23T09:00:00Z',
};

describe('Remediation — what to do about an image', () => {
  it('summarises fixable findings, where the fixes are, and the package upgrades', () => {
    render(<Remediation image={IMAGE} />);
    const sec = screen.getByRole('region', { name: 'Remediation' });
    expect(sec).toHaveTextContent('3 of 4 vulnerabilities have a fix — 3 of 3 critical and high.');
    expect(sec).toHaveTextContent(/Newer image\. Check for a newer release of ingress-nginx\/controller \(this one is v1\.7\.0\)/);
    expect(sec).toHaveTextContent(/Base image\. 2 fixes are operating-system package updates \(alpine 3\.17\.3\)/);
    expect(sec).toHaveTextContent(/Dependencies\. 1 fix is a library upgrade/);
    expect(sec).toHaveTextContent(/No fix yet\. 1 has no fixed version published/);
    const rows = within(sec).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('libcrypto3');
    expect(rows[0]).toHaveTextContent('3.0.8-r3');
    expect(rows[0]).toHaveTextContent('3.0.12-r1');
    expect(rows[1]).toHaveTextContent('golang.org/x/netnginx-ingress-controller');
  });

  it('renders nothing without findings', () => {
    const { container } = render(<Remediation image={{ ...IMAGE, remediation: { total: 0 } }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('VulnTable — fix availability and images still waiting', () => {
  const vuln = {
    images: [IMAGE], summary: IMAGE.summary, results: { ok: 0, vulnerable: 1 }, scanned: 1, notScanned: 2,
    pending: [
      { image: 'postgres:16', namespace: 'shop', status: 'Scanning', workloads: [{ kind: 'StatefulSet', name: 'db', namespace: 'shop' }] },
      { image: 'acme/api:7', namespace: 'shop', status: 'Failed', workloads: [{ kind: 'ReplicaSet', name: 'api-5c4', namespace: 'shop' }] },
    ],
  };

  it('overview: "Fix available" for the critical findings', () => {
    render(<VulnTable vuln={vuln} ns="all" criticalOnly onSelect={() => {}} />);
    expect(screen.getByRole('columnheader', { name: /Fix available/ })).toBeInTheDocument();
    const row = screen.getByRole('row', { name: /ingress-nginx\/controller/ });
    expect(row).toHaveTextContent('2 of 2');
  });

  it('images tab: also lists images being scanned or whose scan failed', () => {
    render(<VulnTable vuln={vuln} ns="all" onSelect={() => {}} />);
    expect(screen.getByRole('row', { name: /postgres:16/ })).toHaveTextContent('Scanning');
    expect(screen.getByRole('row', { name: /acme\/api:7/ })).toHaveTextContent('Failed');
  });
});
