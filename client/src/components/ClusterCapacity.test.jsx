// The dashboard's capacity card: requested / used / limits of allocatable for
// CPU, memory and pod slots, with warning tones as the cluster fills up.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CapacityCard } from './Cluster';

const Gi = 2 ** 30;
const cap = {
  cpuAllocatableMilli: 12000, cpuRequestedMilli: 2700, cpuLimitsMilli: 13200,
  memAllocatableBytes: 45 * Gi, memRequestedBytes: 3.8 * Gi, memLimitsBytes: 8 * Gi,
  podsAllocatable: 330, podsScheduled: 26, podsUnscheduled: 1,
  usage: { available: true, cpuMilli: 1300, memBytes: 20 * Gi },
};

describe('CapacityCard', () => {
  it('says what is requested, used and promised for each resource', () => {
    render(<CapacityCard cap={cap} />);
    expect(screen.getByRole('group', { name: 'CPU: 2.7 of 12 cores requested (23%), 1.3 cores in use, limits 110% of allocatable' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Memory: 3.8Gi of 45Gi requested (8%), 20Gi in use, limits 18% of allocatable' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Pods: 26 of 330 pods scheduled (8%)' })).toBeInTheDocument();
    // Overcommitted CPU limits are flagged; memory limits are not.
    expect(screen.getByText('limits 110%')).toHaveClass('cap-over');
    expect(screen.getByText('limits 18%')).not.toHaveClass('cap-over');
    expect(screen.getByText(/1 pod is waiting for a node with room/)).toBeInTheDocument();
  });

  it('warns at 75% requested and alarms at 90%', () => {
    const { container, rerender } = render(<CapacityCard cap={{ ...cap, cpuRequestedMilli: 9600 }} />);
    expect(container.querySelector('.cap-pct[data-tone="warn"]')).toHaveTextContent('80%');
    rerender(<CapacityCard cap={{ ...cap, cpuRequestedMilli: 11400 }} />);
    expect(container.querySelector('.cap-pct[data-tone="bad"]')).toHaveTextContent('95%');
  });

  it('without metrics-server: requests only, and a note why there is no usage', () => {
    const { container } = render(<CapacityCard cap={{ ...cap, usage: { available: false }, podsUnscheduled: 0 }} />);
    expect(container.querySelectorAll('.cap-use')).toHaveLength(0);
    expect(container.querySelectorAll('.cap-req[data-solid]')).toHaveLength(3);
    expect(screen.getByText('Live usage needs metrics-server in the cluster.')).toBeInTheDocument();
    expect(screen.queryByText(/waiting for a node/)).toBeNull();
  });
});
