// The Dashboard (Cluster.jsx): the whole cluster at a glance — pod health that
// counts crash-looping pods as failing, the Workloads card, and links that open
// a list across all namespaces.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Cluster, { podCounts, workloadStatus } from './Cluster';

vi.mock('../lib/api', async (orig) => {
  const actual = await orig();
  return { ...actual, getJson: vi.fn() };
});
import { getJson } from '../lib/api';

const SLOW = { timeout: 5000 };
const SUMMARY = {
  currentContext: 'dev-env-cluster', serverVersion: 'v1.37.1',
  nodes: { total: 3, ready: 3, notReady: 0 }, roles: { worker: 3 },
  capacity: { cpuCapacity: 12, cpuAllocatable: 11.8, memCapacityBytes: 46 * 2 ** 30, memAllocatableBytes: 43 * 2 ** 30 },
  // Phase says 63 running, but 10 of them crash-loop: the buckets say so.
  pods: { total: 69, phases: { Running: 63, Succeeded: 6 }, buckets: { running: 53, pending: 0, failed: 10, succeeded: 6, unknown: 0 } },
  workloads: {
    deployments: { total: 23, ready: 21, notReady: 2 },
    statefulSets: { total: 5, ready: 5 },
    daemonSets: { total: 16, ready: 16 },
    jobs: { total: 4, complete: 3, failed: 1 },
    cronJobs: { error: 'forbidden' },
    services: { total: 39, ok: 39 },
  },
  namespaceCount: 14,
};

describe('Dashboard', () => {
  beforeEach(() => { vi.clearAllMocks(); getJson.mockResolvedValue(SUMMARY); });

  it('pod health counts crash-looping pods as failing (not "100% healthy")', async () => {
    render(<Cluster context="dev-env-cluster" onOpen={() => {}} />);
    const card = await screen.findByRole('region', { name: 'Pod health' }, SLOW);
    expect(card).toHaveTextContent('86%');
    expect(screen.getByRole('button', { name: /^69 Pods, 53 running · 10 failing/ })).toBeInTheDocument();
  });

  it('the Workloads card: counts and how each kind is doing, cluster-wide', async () => {
    render(<Cluster context="dev-env-cluster" onOpen={() => {}} />);
    const card = await screen.findByRole('region', { name: 'Workloads' }, SLOW);
    expect(card).toHaveTextContent('87 objects · all namespaces');
    expect(within(card).getByRole('button', { name: 'Deployments: 23, 2 not ready. Open Deployments' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'StatefulSets: 5, All ready. Open StatefulSets' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Jobs: 4, 1 failed. Open Jobs' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /^CronJobs: —, Not available/ })).toHaveAttribute('title', 'forbidden');
  });

  it('cards and tiles open their list (across all namespaces, chosen by the shell)', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<Cluster context="dev-env-cluster" onOpen={onOpen} />);
    await user.click(await screen.findByRole('button', { name: /^Deployments: 23/ }, SLOW));
    await user.click(screen.getByRole('button', { name: /^3\/3 Nodes/ }));
    await user.click(screen.getByRole('button', { name: /^14 Namespaces/ }));
    await user.click(screen.getByRole('button', { name: /^69 Pods/ }));
    expect(onOpen.mock.calls.map((c) => c[0])).toEqual(['deployment', 'nodes', 'namespaces', 'pod']);
    // CPU and memory are figures, not links.
    expect(screen.queryByRole('button', { name: /CPU Cores/ })).toBeNull();
  });
});

describe('podCounts / workloadStatus', () => {
  it('prefers the server buckets, falls back to phases', () => {
    expect(podCounts(SUMMARY.pods)).toMatchObject({ running: 53, failed: 10 });
    expect(podCounts({ phases: { Running: 2, Failed: 1 } })).toMatchObject({ running: 2, failed: 1 });
  });
  it('statuses', () => {
    expect(workloadStatus('deployments', { total: 3, ready: 2, scaledDown: 1 })).toEqual({ tone: 'ok', text: 'All ready · 1 scaled to 0' });
    expect(workloadStatus('jobs', { total: 2, active: 2 })).toEqual({ tone: 'info', text: '2 running' });
    expect(workloadStatus('cronJobs', { total: 2, suspended: 1, scheduled: 1 })).toEqual({ tone: 'muted', text: '1 suspended' });
    expect(workloadStatus('services', { total: 0 })).toEqual({ tone: 'muted', text: 'None' });
  });
});
