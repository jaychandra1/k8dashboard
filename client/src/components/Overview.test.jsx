import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Overview, { bucketPods } from './Overview';

const allResources = {
  pods: [
    { name: 'a', status: 'Running' },
    { name: 'b', status: 'Pending' },
    { name: 'c', status: 'Running', containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } } }] },
    { name: 'd', status: 'Succeeded' },
  ],
  deployments: [{ name: 'd1' }],
  statefulSets: [{ name: 's1' }, { name: 's2' }],
  daemonSets: [],
  services: [{ name: 'svc' }],
};

describe('Overview', () => {
  it('buckets pods with podPhaseBucket (container reasons count as failed)', () => {
    expect(bucketPods(allResources.pods)).toEqual({ running: 1, pending: 1, failed: 1, succeeded: 1, unknown: 0 });
  });

  it('renders an h1 and passes registry keys to onResourceTypeChange from bars and KPI cards', async () => {
    const user = userEvent.setup();
    const onResourceTypeChange = vi.fn();
    render(<Overview allResources={allResources} onResourceTypeChange={onResourceTypeChange} />);
    expect(screen.getByRole('heading', { level: 1, name: /Cluster Overview/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'StatefulSets: 2. Open StatefulSets' }));
    expect(onResourceTypeChange).toHaveBeenLastCalledWith('statefulSet');
    await user.click(screen.getByRole('button', { name: /^2 StatefulSets, stateful/ }));
    expect(onResourceTypeChange).toHaveBeenLastCalledWith('statefulSet');
    await user.click(screen.getByRole('button', { name: 'Pods: 4. Open Pods' }));
    expect(onResourceTypeChange).toHaveBeenLastCalledWith('pod');
    expect(onResourceTypeChange).not.toHaveBeenCalledWith('statefulset');
  }, 15000);

  it('shows the loading skeleton only when there is no data yet', () => {
    const { rerender } = render(<Overview allResources={{}} loading onResourceTypeChange={() => {}} />);
    expect(screen.getByRole('status', { name: 'Loading cluster overview' })).toBeInTheDocument();
    rerender(<Overview allResources={allResources} loading onResourceTypeChange={() => {}} />);
    expect(screen.queryByRole('status', { name: 'Loading cluster overview' })).toBeNull();
    expect(screen.getByRole('img', { name: 'Pod health' })).toBeInTheDocument();
  });
});
