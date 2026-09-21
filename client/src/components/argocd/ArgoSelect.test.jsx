import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ArgoSelect from './ArgoSelect';

const options = [
  { value: 'argocd', label: 'argocd' },
  { value: 'default', label: 'default' },
  { value: 'kube-system', label: 'kube-system' },
];

describe('ArgoSelect', () => {
  it('exposes listbox semantics', async () => {
    const user = userEvent.setup();
    render(<ArgoSelect label="Namespace" value="argocd" options={options} onChange={() => {}} />);
    const trigger = screen.getByRole('button', { name: 'Namespace: argocd' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('listbox', { name: 'Namespace' });
    expect(trigger).toHaveAttribute('aria-controls', list.id);
    const opts = screen.getAllByRole('option');
    expect(opts).toHaveLength(3);
    expect(opts[0]).toHaveAttribute('aria-selected', 'true');
    expect(opts[1]).toHaveAttribute('aria-selected', 'false');
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveFocus());
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-activedescendant', opts[0].id);
  });

  it('moves with arrow keys, picks with Enter and filters by typing', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ArgoSelect label="Namespace" value="argocd" options={options} onChange={onChange} />);
    await user.click(screen.getByRole('button'));
    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[1].id);
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('default');
    expect(screen.queryByRole('listbox')).toBeNull();
    // typeahead: typing narrows the options
    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveFocus());
    await user.keyboard('kube');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: 'kube-system' })).toBeInTheDocument();
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<ArgoSelect label="Namespace" value="" placeholder="Pick…" options={options} onChange={() => {}} />);
    const trigger = screen.getByRole('button');
    await user.click(trigger);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
});
