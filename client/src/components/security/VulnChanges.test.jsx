// Images a newer rollout replaced, what each rollout fixed, and image names
// that stay readable (short name first, whole reference on hover, account ids
// masked).
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import VulnTable, { changeOf } from './VulnTable';
import FindingDrawer from './FindingDrawer';
import ImageName, { splitImage } from './ImageName';

const ECR = '241533118296.dkr.ecr.eu-west-1.amazonaws.com';
const counts = (o = {}) => ({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0, ...o });
const opensslFix = { id: 'CVE-2024-5535', severity: 'CRITICAL', pkg: 'libssl3', installedVersion: '3.0.11-1', fixedVersion: '3.0.14-1' };
const curlFix = { id: 'CVE-2024-2398', severity: 'HIGH', pkg: 'libcurl4', installedVersion: '7.88.1-10', fixedVersion: '7.88.1-10+deb12u6' };
const rapidReset = { id: 'CVE-2023-44487', severity: 'CRITICAL', pkg: 'golang.org/x/net', installedVersion: 'v0.12.0', fixedVersion: 'v0.17.0' };

const current = {
  image: `${ECR}/shop/api:1.4.2`, namespace: 'shop', status: 'Scanned', active: true, scannedAt: new Date().toISOString(),
  summary: counts({ CRITICAL: 1, HIGH: 1 }), vulnerabilities: [rapidReset, { id: 'CVE-2024-2961', severity: 'HIGH', pkg: 'glibc', installedVersion: '2.36-9', fixedVersion: '' }],
  workloads: [{ kind: 'ReplicaSet', name: 'api-7f9c', namespace: 'shop', container: 'api', running: true }],
  changes: [{
    workload: 'Deployment api', container: 'api', namespace: 'shop', revision: 7, previousRevision: 6, previousImage: `${ECR}/shop/api:1.4.1`,
    resolved: [opensslFix, curlFix], introduced: [rapidReset],
    resolvedBySeverity: counts({ CRITICAL: 1, HIGH: 1 }), introducedBySeverity: counts({ CRITICAL: 1 }),
  }],
};
const replaced = {
  image: `${ECR}/shop/api:1.4.1`, namespace: 'shop', status: 'Not running', active: false, scannedAt: new Date().toISOString(),
  summary: counts({ CRITICAL: 1, HIGH: 2 }), vulnerabilities: [opensslFix, curlFix],
  workloads: [{ kind: 'ReplicaSet', name: 'api-5c4d', namespace: 'shop', container: 'api', running: false }], changes: [],
};
const vuln = {
  images: [current, replaced], summary: current.summary, results: { ok: 0, vulnerable: 1 }, scanned: 1, notScanned: 0, pending: [],
  inactive: 1, resolved: { total: 2, bySeverity: counts({ CRITICAL: 1, HIGH: 1 }), deployments: 1 },
};

describe('image names', () => {
  it('repo:tag first, registry beneath, the AWS account id masked', () => {
    expect(splitImage(`${ECR}/shop/api:1.4.2`)).toEqual({
      name: 'api:1.4.2', location: '••••8296.dkr.ecr.eu-west-1.amazonaws.com/shop', full: '••••8296.dkr.ecr.eu-west-1.amazonaws.com/shop/api:1.4.2',
    });
    expect(splitImage('grafana/grafana:10.4.1')).toMatchObject({ name: 'grafana/grafana:10.4.1', location: '' });
    expect(splitImage('postgres:16.2')).toMatchObject({ name: 'postgres:16.2', location: '' });
    expect(splitImage('localhost:5000/api:dev')).toMatchObject({ name: 'api:dev', location: 'localhost:5000' });
    const { container } = render(<ImageName image={`${ECR}/shop/api:1.4.2`} />);
    expect(container).toHaveTextContent('api:1.4.2••••8296.dkr.ecr.eu-west-1.amazonaws.com/shop');
    expect(container.textContent).not.toContain('241533118296');
  });

  it('the table cell carries the whole (masked) reference as its title', () => {
    render(<VulnTable vuln={vuln} ns="all" onSelect={() => {}} />);
    const row = screen.getByRole('row', { name: /api:1\.4\.2/ });
    const cell = within(row).getAllByRole('cell')[0];
    expect(cell).toHaveAttribute('title', '••••8296.dkr.ecr.eu-west-1.amazonaws.com/shop/api:1.4.2');
    expect(document.body.textContent).not.toContain('241533118296');
  });
});

describe('images no longer running', () => {
  it('are hidden by default on the overview, behind a toggle that shows them as "Not running"', async () => {
    render(<VulnTable vuln={vuln} ns="all" criticalOnly onSelect={() => {}} />);
    const table = screen.getByRole('table', { name: /^Running images with critical vulnerabilities/ });
    expect(within(table).queryByRole('row', { name: /api:1\.4\.1/ })).toBeNull();
    const toggle = screen.getByRole('checkbox', { name: 'Show 1 image no longer running' });
    await userEvent.click(toggle);
    const row = within(table).getByRole('row', { name: /api:1\.4\.1/ });
    expect(row).toHaveTextContent('Not running');
    expect(row).toHaveAttribute('data-tone', 'inactive');
  });

  it('the overview shows what the rollout fixed: column, donut and a "fixed since" table', () => {
    render(<VulnTable vuln={vuln} ns="all" criticalOnly onSelect={() => {}} />);
    expect(screen.getByRole('columnheader', { name: /Since last version/ })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: /^Running images with critical vulnerabilities/ });
    const row = within(table).getByRole('row', { name: /api:1\.4\.2/ });
    expect(within(row).getByLabelText('2 fixed since the previous version')).toBeInTheDocument();
    expect(within(row).getByLabelText('1 new since the previous version')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Fixed since last version' })).toHaveTextContent('2');
    const fixes = screen.getByRole('table', { name: /^What the latest rollouts fixed and introduced/ });
    expect(within(fixes).getByRole('row', { name: /api/ })).toHaveTextContent('api:1.4.1→api:1.4.2');
  });

  it('changeOf sums the per-severity counts', () => {
    expect(changeOf(current)).toMatchObject({ fixed: 2, added: 1 });
    expect(changeOf(replaced)).toBeNull();
  });
});

describe('finding drawer', () => {
  it('lists what the image fixed and introduced since the previous version', () => {
    render(<FindingDrawer detail={{ type: 'image', data: current }} onClose={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Since the previous version' })).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Changes in Deployment api' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      'FixedCRITICALCVE-2024-5535libssl3 3.0.11-1',
      'FixedHIGHCVE-2024-2398libcurl4 7.88.1-10',
      'NewCRITICALCVE-2023-44487golang.org/x/net v0.12.0',
    ]);
    expect(screen.getByRole('dialog')).toHaveTextContent('revision 6 → 7');
    expect(screen.getByRole('dialog').textContent).not.toContain('241533118296');
  });

  it('explains an image that no longer runs', () => {
    render(<FindingDrawer detail={{ type: 'image', data: replaced }} onClose={() => {}} />);
    expect(screen.getByRole('dialog')).toHaveTextContent('No pod runs this image any more');
  });
});
