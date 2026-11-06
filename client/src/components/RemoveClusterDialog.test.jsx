import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RemoveClusterDialog from './RemoveClusterDialog';

vi.mock('../lib/api', async (orig) => {
  const actual = await orig();
  return { ...actual, postJson: vi.fn() };
});
import { postJson } from '../lib/api';

const SLOW = { timeout: 5000 };
const PLAN = {
  context: 'tr-prod-cashierbackend', file: '~/.kube/config', current: true, switchTo: 'dev-env-cluster', lastCluster: false,
  user: { name: 'arn:aws:eks:eu-west-1:241533118296:cluster/cashier', removed: true, usedBy: [] },
  cluster: { name: 'shared-server', removed: false, usedBy: ['tr-prod-multibrands-cluster'] },
  awsProfile: { name: 'sso-241533118296', removable: true, usedBy: [] },
};

describe('RemoveClusterDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postJson.mockImplementation(async (url, body) => (body.dryRun ? PLAN : { ...PLAN, removed: true, currentContext: 'dev-env-cluster' }));
  });

  it('shows exactly what goes and what stays (names masked), and removes only on confirm', async () => {
    const user = userEvent.setup();
    const onRemoved = vi.fn();
    render(<RemoveClusterDialog context="tr-prod-cashierbackend" onClose={() => {}} onRemoved={onRemoved} />);
    const dialog = await screen.findByRole('dialog', {}, SLOW);
    const list = await within(dialog).findByRole('list', { name: 'What is removed' }, SLOW);
    expect(list).toHaveTextContent('The cluster tr-prod-cashierbackend');
    expect(list).toHaveTextContent('Its credentials entry arn:aws:eks:eu-west-1:••••8296:cluster/cashier');
    expect(list).toHaveTextContent('Kept: its server entry shared-server, used by tr-prod-multibrands-cluster');
    expect(dialog).toHaveTextContent('K8Board switches to dev-env-cluster');
    expect(dialog).toHaveTextContent('~/.kube/config');
    expect(dialog.textContent).not.toMatch(/241533118296/);
    expect(postJson).toHaveBeenCalledTimes(1);
    expect(postJson).toHaveBeenCalledWith('/api/config/contexts/remove', { context: 'tr-prod-cashierbackend', dryRun: true });

    await user.click(within(dialog).getByRole('checkbox', { name: /Also remove its AWS profile sso-••••8296/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Remove cluster' }));
    await waitFor(() => expect(postJson).toHaveBeenLastCalledWith('/api/config/contexts/remove', { context: 'tr-prod-cashierbackend', removeAwsProfile: true }));
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith(expect.objectContaining({ removed: true, currentContext: 'dev-env-cluster' })));
  });

  it('the confirm button waits for the preview; a shared AWS profile is only mentioned', async () => {
    let resolve;
    postJson.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    render(<RemoveClusterDialog context="dev" onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog', {}, SLOW);
    expect(within(dialog).getByRole('button', { name: 'Remove cluster' })).toBeDisabled();
    resolve({ ...PLAN, context: 'dev', current: false, switchTo: null, awsProfile: { name: 'dev', removable: false, usedBy: ['qa'] } });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Remove cluster' })).toBeEnabled());
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(dialog).toHaveTextContent('Its AWS profile dev stays: qa uses it too.');
  });

  it('a failed removal is reported and nothing closes', async () => {
    const user = userEvent.setup();
    const onRemoved = vi.fn();
    postJson.mockImplementation(async (url, body) => { if (body.dryRun) return PLAN; throw new Error('disk full'); });
    render(<RemoveClusterDialog context="tr-prod-cashierbackend" onClose={() => {}} onRemoved={onRemoved} />);
    const dialog = await screen.findByRole('dialog', {}, SLOW);
    await within(dialog).findByRole('list', { name: 'What is removed' }, SLOW);
    await user.click(within(dialog).getByRole('button', { name: 'Remove cluster' }));
    expect(await within(dialog).findByRole('alert', {}, SLOW)).toHaveTextContent('disk full');
    expect(onRemoved).not.toHaveBeenCalled();
  });
});
