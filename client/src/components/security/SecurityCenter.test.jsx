import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SecurityCenter from './SecurityCenter';
import { getJson, ApiError } from '../../lib/api';

vi.mock('../../lib/api', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, getJson: vi.fn(), postJson: vi.fn() };
});

const image = {
  image: 'nginx:1.25', namespace: 'web', status: 'Scanned', scannedAt: '2024-05-01T00:00:00Z',
  summary: { CRITICAL: 2, HIGH: 1, MEDIUM: 0, LOW: 0, UNKNOWN: 0 },
  workloads: [{ kind: 'Deployment', namespace: 'web', name: 'nginx' }],
  vulnerabilities: [{ id: 'CVE-2024-0001', severity: 'CRITICAL', pkg: 'openssl', installedVersion: '1.0', fixedVersion: '1.1', link: 'https://nvd.example/CVE-2024-0001' }],
};

describe('SecurityCenter', () => {
  beforeEach(() => { getJson.mockReset(); });

  it('shows an RBAC error state when the vulnerability reports are forbidden', async () => {
    getJson.mockImplementation(async (url) => {
      if (url.endsWith('/security/status')) return { installed: true };
      if (url.endsWith('/security/vulnerabilities')) throw new ApiError({ status: 403, code: 'forbidden', message: 'vulnerabilityreports is forbidden' });
      return {};
    });
    render(<SecurityCenter view="overview" namespaces={['all', 'web']} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Your RBAC role can't read vulnerability reports");
    expect(alert).toHaveTextContent('HTTP 403');
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Security' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Namespace' })).toBeInTheDocument();
  });

  it('opens the finding drawer as a non-modal dialog and closes it with Escape', async () => {
    const user = userEvent.setup();
    getJson.mockImplementation(async (url) => {
      if (url.endsWith('/security/status')) return { installed: true };
      if (url.endsWith('/security/vulnerabilities')) return { installed: true, images: [image], summary: image.summary, scanned: 1, notScanned: 0, results: { ok: 0, vulnerable: 1 } };
      return {};
    });
    render(<SecurityCenter view="overview" namespaces={['all', 'web']} />);
    const table = await screen.findByRole('table', { name: /critical vulnerabilities/i });
    const tbody = within(table).getAllByRole('rowgroup')[1];
    await user.click(within(tbody).getAllByRole('row')[0]);
    const dialog = await screen.findByRole('dialog', { name: /nginx:1.25/ });
    expect(dialog).toHaveAttribute('aria-modal', 'false');
    await waitFor(() => expect(dialog).toHaveFocus());
    expect(within(dialog).getByRole('button', { name: 'Close finding details' })).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /CVE-2024-0001/ })).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
