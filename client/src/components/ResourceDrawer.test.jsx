import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ResourceDrawer from './ResourceDrawer';

vi.mock('../lib/api', async (orig) => {
  const actual = await orig();
  return { ...actual, getJson: vi.fn() };
});
import { getJson } from '../lib/api';

const secret = {
  kind: 'Secret',
  metadata: { name: 'db-creds', namespace: 'prod', creationTimestamp: '2024-01-01T00:00:00Z', labels: { app: 'db' } },
  type: 'Opaque',
  data: { password: btoa('hunter2') },
};

describe('ResourceDrawer', () => {
  beforeEach(() => { vi.clearAllMocks(); getJson.mockResolvedValue(secret); });

  it('is a non-modal dialog labelled by the resource name, focuses its heading and closes on Escape', async () => {
    const onClose = vi.fn();
    render(
      <>
        <button>row</button>
        <ResourceDrawer resource={{ name: 'db-creds', namespace: 'prod' }} resourceType="secret" onClose={onClose} />
      </>,
    );
    const dlg = screen.getByRole('dialog', { name: 'db-creds' });
    expect(dlg).toHaveAttribute('aria-modal', 'false');
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'db-creds' })).toHaveFocus());
    expect(getJson).toHaveBeenCalledWith('/api/resource/prod/Secret/db-creds', expect.anything());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Close details' })).toBeInTheDocument();
  });

  it('hides secret values until revealed per key and offers copy', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ResourceDrawer resource={{ name: 'db-creds', namespace: 'prod' }} resourceType="secret" onClose={() => {}} />);
    await screen.findByText('Data (1)');
    expect(screen.queryByText('hunter2')).toBeNull();
    const reveal = screen.getByRole('button', { name: 'Reveal value of password' });
    expect(reveal).toHaveAttribute('aria-pressed', 'false');
    await user.click(reveal);
    expect(screen.getByText('hunter2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide value of password' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Copy value of password' }));
    expect(writeText).toHaveBeenCalledWith('hunter2');
  });

  it('renders cross-links as real hash anchors', async () => {
    render(<ResourceDrawer resource={{ name: 'db-creds', namespace: 'prod' }} resourceType="secret" onClose={() => {}} />);
    const link = await screen.findByRole('link', { name: 'prod' });
    expect(link).toHaveAttribute('href', '#/pod?ns=prod');
  });
});
