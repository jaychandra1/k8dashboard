import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CommandPalette from './CommandPalette';

const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

describe('CommandPalette', () => {
  it('exposes combobox/listbox roles inside a modal dialog', async () => {
    render(<CommandPalette open onClose={() => {}} onNavigate={() => {}} contexts={['test-cluster']} currentContext="test-cluster" onSwitchContext={() => {}} />);
    await tick();
    const dlg = screen.getByRole('dialog', { name: 'Command palette' });
    expect(dlg).toHaveAttribute('aria-modal', 'true');
    const input = screen.getByRole('combobox', { name: 'Search views, contexts and actions' });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-autocomplete', 'list');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('listbox');
    expect(input).toHaveAttribute('aria-controls', list.id);
    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThan(10);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', options[0].id);
    expect(screen.getByRole('option', { name: /Pods/ })).toBeInTheDocument();
  });

  it('filters, moves with arrows and runs the selection on Enter', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} onNavigate={onNavigate} contexts={[]} onSwitchContext={() => {}} />);
    await tick();
    await user.keyboard('deploy');
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Deployments');
    await user.keyboard('{Enter}');
    expect(onNavigate).toHaveBeenCalledWith('deployment');
    expect(onClose).toHaveBeenCalled();
  });

  it('arrow keys change the active option and Escape closes', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} onNavigate={onNavigate} contexts={[]} onSwitchContext={() => {}} />);
    await tick();
    const input = screen.getByRole('combobox');
    const options = screen.getAllByRole('option');
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', options[2].id);
    expect(options[2]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    expect(onNavigate).toHaveBeenCalledWith('nodes');
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
