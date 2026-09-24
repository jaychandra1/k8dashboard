import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import KubeConfigModal from './KubeConfigModal';

describe('KubeConfigModal (connect screen)', () => {
  it('presents exactly two paths — a kubeconfig path or Add cluster (AWS / Azure) — and no demo', () => {
    const onAddAws = vi.fn();
    const onAddAzure = vi.fn();
    render(<KubeConfigModal defaultPath="/home/me/.kube/config" exists={false} onSubmit={async () => null} onAddAws={onAddAws} onAddAzure={onAddAzure} />);

    expect(screen.getByRole('dialog', { name: 'Connect a cluster' })).toBeInTheDocument();
    expect(screen.getByLabelText('Kubeconfig file path')).toHaveValue('/home/me/.kube/config');
    expect(screen.getByRole('button', { name: /^Load kubeconfig$/ })).toBeInTheDocument();

    const group = screen.getByRole('group', { name: 'Add cluster' });
    fireEvent.click(screen.getByRole('button', { name: /AWS EKS/ }));
    fireEvent.click(screen.getByRole('button', { name: /Azure AKS/ }));
    expect(group).toBeInTheDocument();
    expect(onAddAws).toHaveBeenCalledTimes(1);
    expect(onAddAzure).toHaveBeenCalledTimes(1);

    expect(screen.queryByText(/demo/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /demo/i })).toBeNull();
    expect(screen.getAllByRole('button').filter((b) => !/close/i.test(b.getAttribute('aria-label') || ''))).toHaveLength(3);
  });

  it('hides the Add cluster section when no import handlers are given', () => {
    render(<KubeConfigModal defaultPath="" exists={false} onSubmit={async () => null} />);
    expect(screen.queryByRole('group', { name: 'Add cluster' })).toBeNull();
    expect(screen.queryByText(/demo/i)).toBeNull();
  });

  it('shows the submit error inline and keeps the form usable', async () => {
    const onSubmit = vi.fn(async () => ({ code: 'invalid_kubeconfig', message: 'Invalid kubeconfig: bad yaml' }));
    render(<KubeConfigModal defaultPath="/x/config" exists onSubmit={onSubmit} />);
    fireEvent.submit(screen.getByRole('button', { name: /^Load kubeconfig$/ }).closest('form'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Invalid kubeconfig/);
    expect(onSubmit).toHaveBeenCalledWith('/x/config');
  });
});
