import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ClusterSwitcher from './ClusterSwitcher';

const contextsInfo = [
  { name: 'dev-env-cluster', provider: 'aws' },
  { name: 'kind-local', provider: 'local' },
  { name: 'mystery', provider: 'something-new' },
];

describe('ClusterSwitcher (the top-bar cluster button)', () => {
  it('shows the connected cluster with its provider icon, and opens the Switch cluster window', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<ClusterSwitcher contextsInfo={contextsInfo} currentContext="dev-env-cluster" onOpen={onOpen} />);
    const btn = screen.getByRole('button', { name: 'Switch cluster (current: dev-env-cluster)' });
    expect(btn).toHaveTextContent('dev-env-cluster');
    expect(btn).toHaveAttribute('aria-haspopup', 'dialog');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('.ctx-provider-aws')).not.toBeNull();
    expect(container.querySelector('.cluster-switcher-caret')).not.toBeNull();
    await user.click(btn);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('is a button, not a menu: it lists no clusters itself, however many there are', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `cluster-${i}`, provider: 'aws' }));
    render(<ClusterSwitcher contextsInfo={many} currentContext="cluster-7" onOpen={() => {}} />);
    await user.click(screen.getByRole('button', { name: /Switch cluster/ }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByText('cluster-8')).toBeNull();
    expect(screen.queryByText(/pin/i)).toBeNull();
  });

  it('keyboard: Enter, Space and ArrowDown open the window', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(<ClusterSwitcher contextsInfo={contextsInfo} currentContext="kind-local" onOpen={onOpen} />);
    screen.getByRole('button', { name: /Switch cluster/ }).focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    await user.keyboard('{ArrowDown}');
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it('says the window is open, and copes with no cluster or an unknown provider', () => {
    const { rerender, container } = render(<ClusterSwitcher contextsInfo={contextsInfo} currentContext="mystery" open onOpen={() => {}} />);
    expect(screen.getByRole('button', { name: /Switch cluster/ })).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('.ctx-provider-other')).not.toBeNull();
    rerender(<ClusterSwitcher contextsInfo={contextsInfo} currentContext={null} onOpen={() => {}} />);
    expect(screen.getByRole('button', { name: 'Switch cluster (current: none)' })).toHaveTextContent('No cluster');
  });
});
