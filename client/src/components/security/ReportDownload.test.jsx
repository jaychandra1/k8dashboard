// "Download report" in the Security Center drawer: the menu, which formats it
// offers (PDF only in the desktop app), and what each one saves — for images
// (vulnerabilities) and for resources and roles (failed checks).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FindingDrawer from './FindingDrawer';

const getJson = vi.fn();
vi.mock('../../lib/api', async (orig) => ({ ...(await orig()), getJson: (...a) => getJson(...a) }));
const downloadFile = vi.fn();
vi.mock('../../lib/download', () => ({ downloadFile: (...a) => downloadFile(...a) }));

const ECR = '241533118296.dkr.ecr.eu-west-1.amazonaws.com';
const counts = (o = {}) => ({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0, ...o });
const IMAGE = {
  image: `${ECR}/bo-backend:release-359`, repository: 'bo-backend', tag: 'release-359', namespace: 'uat', status: 'Scanned', active: true,
  scannedAt: '2026-11-04T18:20:00Z', summary: counts({ CRITICAL: 1, MEDIUM: 1 }),
  workloads: [{ kind: 'ReplicaSet', name: 'uat-api-7f9', namespace: 'uat', container: 'app', running: true }],
  vulnerabilities: [
    { id: 'CVE-2025-24813', severity: 'CRITICAL', pkg: 'tomcat-embed-core', installedVersion: '10.1.55', fixedVersion: '10.1.59', score: 9.8 },
    { id: 'CVE-2024-0001', severity: 'MEDIUM', pkg: 'libexpat', installedVersion: '2.8.2-r0', fixedVersion: '' },
  ],
};
const DETAILS = { source: 'operator', available: true, details: [{ id: 'CVE-2025-24813', pkg: 'tomcat-embed-core', installedVersion: '10.1.55', description: 'Partial PUT can lead to RCE.', links: [] }] };

const openDrawer = (data = IMAGE) => render(<FindingDrawer detail={{ type: 'image', data }} onClose={() => {}} context="uat-cluster" />);
const openMenu = async (user) => {
  await user.click(screen.getByRole('button', { name: 'Download vulnerability report' }));
  return screen.getByRole('menu', { name: 'Download report' });
};

beforeEach(() => {
  getJson.mockReset().mockResolvedValue(DETAILS);
  downloadFile.mockReset();
});
afterEach(() => { delete window.k8boardHost; });

describe('Download report', () => {
  it('offers HTML and CSV in a browser (no PDF without the desktop app)', async () => {
    const user = userEvent.setup();
    openDrawer();
    const menu = await openMenu(user);
    const items = [...menu.querySelectorAll('[role="menuitem"]')].map((b) => b.querySelector('.context-menu-label').textContent);
    expect(items).toEqual(['HTML report', 'CSV spreadsheet']);
  });

  it('saves the complete HTML report, with the advisory details fetched for this image', async () => {
    const user = userEvent.setup();
    openDrawer();
    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /HTML report/ }));
    await waitFor(() => expect(downloadFile).toHaveBeenCalledTimes(1));
    expect(getJson).toHaveBeenCalledWith('/api/security/vulnerabilities/details', { params: { image: IMAGE.image } });
    const [html, name, type] = downloadFile.mock.calls[0];
    expect(name).toMatch(/^vulnerability-report_bo-backend_release-359_\d{4}-\d{2}-\d{2}\.html$/);
    expect(type).toBe('text/html;charset=utf-8');
    expect(html).toContain('Partial PUT can lead to RCE.');
    expect(html).toContain('CVE-2024-0001');
    expect(html).not.toContain('241533118296');
  });

  it('saves a CSV; a failed details request still gives a report', async () => {
    getJson.mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    openDrawer();
    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /CSV spreadsheet/ }));
    await waitFor(() => expect(downloadFile).toHaveBeenCalledTimes(1));
    const [csv, name] = downloadFile.mock.calls[0];
    expect(name).toMatch(/\.csv$/);
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(3);
  });

  it('in the desktop app, PDF comes first and is rendered by the host', async () => {
    const reportPdf = vi.fn().mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
    window.k8boardHost = { reportPdf };
    const user = userEvent.setup();
    openDrawer();
    const menu = await openMenu(user);
    expect(menu.querySelector('[role="menuitem"] .context-menu-label').textContent).toBe('PDF report');
    await user.click(screen.getByRole('menuitem', { name: /PDF report/ }));
    await waitFor(() => expect(downloadFile).toHaveBeenCalledTimes(1));
    expect(reportPdf.mock.calls[0][0].startsWith('<!doctype html>')).toBe(true);
    const [blob, name] = downloadFile.mock.calls[0];
    expect(blob.type).toBe('application/pdf');
    expect(name).toMatch(/^vulnerability-report_bo-backend_release-359_.*\.pdf$/);
  });

  it('a refused PDF shows the reason, without Electron\'s IPC prefix', async () => {
    window.k8boardHost = { reportPdf: vi.fn().mockRejectedValue(new Error("Error invoking remote method 'k8board:report-pdf': Error: A report is already being prepared.")) };
    const { downloadReport } = await import('./ReportDownload');
    await expect(downloadReport({ type: 'image', data: IMAGE }, 'pdf')).rejects.toThrow(/^A report is already being prepared\.$/);
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('is disabled until the image has been scanned', () => {
    openDrawer({ ...IMAGE, pending: true, status: 'Scanning', vulnerabilities: [] });
    expect(screen.getByRole('button', { name: /Download report \(available once the image is scanned\)/ })).toBeDisabled();
  });

});

describe('Download report: resource checks', () => {
  const RESOURCE = {
    kind: 'Deployment', name: 'payments', namespace: 'shop', scannedAt: '2026-11-04T18:20:00Z', summary: counts({ HIGH: 1 }),
    checks: [{ id: 'KSV012', title: 'Runs as root user', severity: 'HIGH', category: 'Kubernetes Security Check', message: "Container 'api' should set runAsNonRoot", remediation: 'Set runAsNonRoot: true' }],
  };
  const openChecks = (data = RESOURCE, which = 'config') => render(<FindingDrawer detail={{ type: 'checks', data, which }} onClose={() => {}} context="uat-cluster" />);

  it('a resource gets its configuration audit report, with no server call and no product name', async () => {
    const user = userEvent.setup();
    openChecks();
    await user.click(screen.getByRole('button', { name: 'Download configuration audit report' }));
    await user.click(screen.getByRole('menuitem', { name: /HTML report/ }));
    await waitFor(() => expect(downloadFile).toHaveBeenCalledTimes(1));
    expect(getJson).not.toHaveBeenCalled();
    const [html, name] = downloadFile.mock.calls[0];
    expect(name).toMatch(/^config-audit-report_shop_deployment-payments_\d{4}-\d{2}-\d{2}\.html$/);
    expect(html).toContain('Configuration audit report');
    expect(html).toContain('KSV012');
    expect(html).not.toMatch(/K8Board|<img/);
  });

  it('a role from the Roles tab gets its RBAC assessment report, as CSV', async () => {
    const user = userEvent.setup();
    openChecks({ ...RESOURCE, kind: 'ClusterRole', name: 'shop-deployer', namespace: '' }, 'rbac');
    await user.click(screen.getByRole('button', { name: 'Download RBAC assessment report' }));
    await user.click(screen.getByRole('menuitem', { name: /CSV spreadsheet/ }));
    await waitFor(() => expect(downloadFile).toHaveBeenCalledTimes(1));
    const [csv, name] = downloadFile.mock.calls[0];
    expect(name).toMatch(/^rbac-assessment-report_clusterrole-shop-deployer_.*\.csv$/);
    expect(csv).toContain('"KSV012","High","Runs as root user"');
  });
});
