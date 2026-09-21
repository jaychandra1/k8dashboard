import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Topology from './Topology';
import { getJson } from '../lib/api';

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, getJson: vi.fn() };
});

const topology = {
  nodes: [
    { id: 'deploy/web', kind: 'Deployment', name: 'web', category: 'workload', status: 'Running' },
    { id: 'pod/web-1', kind: 'Pod', name: 'web-1', category: 'workload', status: 'Running' },
    { id: 'svc/web', kind: 'Service', name: 'web', category: 'network', status: '' },
    { id: 'cm/web', kind: 'ConfigMap', name: 'web', category: 'config' },
  ],
  edges: [
    { source: 'deploy/web', target: 'pod/web-1', type: 'owns' },
    { source: 'svc/web', target: 'pod/web-1', type: 'service' },
    { source: 'deploy/web', target: 'cm/web', type: 'config' },
  ],
};

beforeEach(() => { getJson.mockResolvedValue(topology); });

describe('Topology', () => {
  it('renders the graph as a labelled image with a title and focusable nodes', async () => {
    const onSelectResource = vi.fn();
    render(<Topology namespaces={['all', 'default', 'kube-system']} onSelectResource={onSelectResource} />);
    const svg = await screen.findByRole('img', { name: /Topology of namespace default: 4 resources, 3 relationships/ });
    expect(svg.querySelector('title')).toHaveTextContent('Topology of namespace default');
    expect(getJson).toHaveBeenCalledWith('/api/topology/default', expect.anything());
    expect(screen.getByRole('combobox', { name: 'Namespace' })).toHaveValue('default');
    expect(screen.getByRole('heading', { level: 1, name: 'Topology' })).toBeInTheDocument();
    const node = screen.getByRole('button', { name: 'Pod web-1, status Running' });
    expect(node).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(node, { key: 'Enter' });
    expect(onSelectResource).toHaveBeenCalledWith(expect.objectContaining({ kind: 'Pod', name: 'web-1', namespace: 'default' }));
    // status dots carry text, not just colour (one per Running node)
    expect(screen.getAllByRole('img', { name: 'Status: Running' })).toHaveLength(2);
  });

  it('filter chips are toggle buttons with aria-pressed and a text "off" state', async () => {
    const user = userEvent.setup();
    render(<Topology namespaces={['default']} />);
    const chip = await screen.findByRole('button', { name: /^Network/ });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('img', { name: /4 resources, 3 relationships/ })).toBeInTheDocument();
    await user.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(chip).toHaveTextContent('(hidden)');
    expect(screen.getByRole('img', { name: /3 resources, 2 relationships/ })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Resource categories' })).toBeInTheDocument();
  });

  it('offers an accessible list view of the same nodes', async () => {
    const user = userEvent.setup();
    render(<Topology namespaces={['default']} />);
    await screen.findByRole('img', { name: /Topology of namespace default/ });
    await user.click(screen.getByRole('button', { name: 'List view' }));
    expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', '4');
    expect(screen.queryByRole('img', { name: /Topology of namespace/ })).toBeNull();
  });
});
