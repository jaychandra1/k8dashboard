import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Helm from './Helm';

vi.mock('../lib/api', async (orig) => {
  const actual = await orig();
  return { ...actual, getJson: vi.fn() };
});
// xterm needs a real canvas; the terminal itself is covered by the server's end-to-end test.
vi.mock('./TerminalViewer', () => ({
  default: ({ wsParams, title, onClose, onCommand }) => (
    <div data-testid="terminal" data-params={JSON.stringify(wsParams)}>
      {title}
      <button type="button" onClick={onCommand}>run</button>
      <button type="button" onClick={onClose}>close terminal</button>
    </div>
  ),
}));
import { getJson } from '../lib/api';

const RELEASES = { releases: [{ name: 'trivy-operator', namespace: 'trivy-system', chart: 'trivy-operator-0.30.0', appVersion: '0.43.0', revision: '12', status: 'deployed', updated: '2026-07-01T10:00:00Z' }] };

function mockApi({ terminal }) {
  getJson.mockImplementation(async (url) => {
    if (url === '/api/helm-terminal') return terminal;
    if (url === '/api/helm/releases') return RELEASES;
    if (url.startsWith('/api/helm/releases/')) return { yaml: 'replicaCount: 1\n' };
    throw new Error(`unexpected ${url}`);
  });
}

describe('Helm page — "+ Helm terminal"', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('is offered only where the server can open one (desktop app)', async () => {
    mockApi({ terminal: { available: false, reason: 'desktop_only', context: 'dev', helm: { installed: false } } });
    render(<Helm />);
    await screen.findByText('trivy-operator');
    await waitFor(() => expect(getJson).toHaveBeenCalledWith('/api/helm-terminal', expect.anything()));
    expect(screen.queryByRole('button', { name: /Helm terminal/ })).toBeNull();
  });

  it('opens a terminal tab pinned to the current cluster, alongside a release\'s tabs', async () => {
    mockApi({ terminal: { available: true, reason: null, context: 'arn:aws:eks:eu-west-1:1:cluster/dev-env-cluster', helm: { installed: true } } });
    const user = userEvent.setup();
    render(<Helm />);
    await screen.findByText('trivy-operator');
    const open = await screen.findByRole('button', { name: /Helm terminal/ });
    expect(open).toHaveAttribute('title', 'Open a terminal where helm and kubectl run against dev-env-cluster only');
    await user.click(open);

    const tab = screen.getByRole('tab', { name: /Helm terminal · dev-env-cluster/ });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    const term = screen.getByTestId('terminal');
    expect(JSON.parse(term.dataset.params)).toEqual({ shell: 'helm' });
    expect(term).toHaveTextContent('helm · dev-env-cluster');

    // Selecting a release adds its tabs; the terminal stays open (mounted) behind them.
    await user.click(screen.getByText('trivy-operator'));
    expect(screen.getByRole('tab', { name: /Values/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.getByTestId('terminal')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /Helm terminal/ }));
    expect(screen.getByRole('tab', { name: /Helm terminal/ })).toHaveAttribute('aria-selected', 'true');

    // The terminal tab's own × closes just the terminal.
    await user.click(screen.getByRole('button', { name: 'Close Helm terminal' }));
    expect(screen.queryByTestId('terminal')).toBeNull();
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  it('refreshes the release list after a command is entered in the terminal', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockApi({ terminal: { available: true, reason: null, context: 'dev', helm: { installed: true } } });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<Helm />);
      await screen.findByText('trivy-operator');
      await user.click(await screen.findByRole('button', { name: /Helm terminal/ }));
      const releaseCalls = () => getJson.mock.calls.filter(([u]) => u === '/api/helm/releases').length;
      const startCalls = releaseCalls();
      await user.click(within(screen.getByTestId('terminal')).getByRole('button', { name: 'run' }));
      await act(async () => { vi.advanceTimersByTime(3100); });
      await waitFor(() => expect(releaseCalls()).toBe(startCalls + 1));
      await act(async () => { vi.advanceTimersByTime(12000); });
      await waitFor(() => expect(releaseCalls()).toBe(startCalls + 2));
    } finally {
      vi.useRealTimers();
    }
  });
});
