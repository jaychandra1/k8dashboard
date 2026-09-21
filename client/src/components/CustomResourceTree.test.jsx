import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CustomResourceTree from './CustomResourceTree';
import { getJson, ApiError } from '../lib/api';

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, getJson: vi.fn() };
});

const crd = { name: 'certificates.cert-manager.io', group: 'cert-manager.io', version: 'v1', plural: 'certificates', kind: 'Certificate', scope: 'Namespaced' };
const tick = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  getJson.mockImplementation(async (url) => {
    if (url === '/api/customresources') return { crds: [crd] };
    if (url === '/api/customresources/cert-manager.io/v1/certificates') return { items: [{ name: 'site-tls', namespace: 'web', createdAt: '2024-01-01T00:00:00Z' }] };
    return {};
  });
});

describe('CustomResourceTree', () => {
  it('is a tree of treeitems with aria-expanded and roving tabindex', async () => {
    render(<CustomResourceTree selection={null} onSelect={() => {}} />);
    const tree = screen.getByRole('tree', { name: 'Custom resources' });
    const root = screen.getByRole('treeitem', { name: /Custom Resources/ });
    expect(tree).toContainElement(root);
    expect(root).toHaveAttribute('aria-expanded', 'false');
    expect(root).toHaveAttribute('tabindex', '0');
    expect(root).toHaveAttribute('aria-level', '1');
    fireEvent.keyDown(root, { key: 'Enter' });
    expect(root).toHaveAttribute('aria-expanded', 'true');
    const group = await screen.findByRole('treeitem', { name: /cert-manager\.io/ });
    expect(group).toHaveAttribute('aria-level', '2');
    expect(group).toHaveAttribute('tabindex', '-1');
  });

  it('navigates with arrow keys and selects with Enter', async () => {
    const onSelect = vi.fn();
    render(<CustomResourceTree selection={null} onSelect={onSelect} />);
    const root = screen.getByRole('treeitem', { name: /Custom Resources/ });
    root.focus();
    fireEvent.keyDown(root, { key: 'ArrowRight' }); // expands
    const group = await screen.findByRole('treeitem', { name: /cert-manager\.io/ });
    fireEvent.keyDown(root, { key: 'ArrowDown' });
    await tick();
    expect(group).toHaveFocus();
    expect(group).toHaveAttribute('tabindex', '0');
    expect(root).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(group, { key: 'ArrowRight' }); // expand the group
    expect(group).toHaveAttribute('aria-expanded', 'true');
    const kind = await screen.findByRole('treeitem', { name: /^Certificate/ });
    fireEvent.keyDown(group, { key: 'ArrowRight' }); // already expanded → first child
    await tick();
    expect(kind).toHaveFocus();
    fireEvent.keyDown(kind, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ level: 'kind', plural: 'certificates', group: 'cert-manager.io' }));
    fireEvent.keyDown(kind, { key: 'ArrowRight' }); // expand → loads instances
    const inst = await screen.findByRole('treeitem', { name: /site-tls/ });
    expect(inst).toHaveAttribute('aria-level', '4');
    expect(inst).not.toHaveAttribute('aria-expanded');
    fireEvent.keyDown(kind, { key: 'ArrowLeft' }); // collapse
    await waitFor(() => expect(screen.queryByRole('treeitem', { name: /site-tls/ })).toBeNull());
    fireEvent.keyDown(kind, { key: 'ArrowLeft' }); // to parent
    await tick();
    expect(group).toHaveFocus();
  });

  it('shows an RBAC-specific error with retry when CRDs are forbidden', async () => {
    getJson.mockImplementation(async (url) => {
      if (url === '/api/customresources') throw new ApiError({ status: 403, code: 'forbidden', message: 'forbidden' });
      return {};
    });
    render(<CustomResourceTree selection={null} onSelect={() => {}} />);
    fireEvent.click(screen.getByRole('treeitem', { name: /Custom Resources/ }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Your RBAC role can't read CRDs");
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
