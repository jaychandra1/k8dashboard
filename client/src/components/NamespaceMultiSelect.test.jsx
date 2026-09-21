import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NamespaceMultiSelect from './NamespaceMultiSelect';

const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

describe('NamespaceMultiSelect', () => {
  it('has a listbox trigger and toggles options with the keyboard', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<NamespaceMultiSelect namespaces={['default', 'kube-system', 'monitoring']} selected={['all']} onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: /Namespaces: All namespaces/ });
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    trigger.focus();
    await user.keyboard('{ArrowDown}');
    await tick();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('listbox', { name: 'Namespaces' });
    expect(list).toHaveAttribute('aria-multiselectable', 'true');
    expect(list).toHaveFocus();
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(4);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowDown}{ArrowDown}'); // → kube-system
    expect(list).toHaveAttribute('aria-activedescendant', options[2].id);
    await user.keyboard(' ');
    expect(onChange).toHaveBeenLastCalledWith(['kube-system']);

    await user.keyboard('m'); // typeahead → monitoring
    expect(list).toHaveAttribute('aria-activedescendant', options[3].id);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('renders tags with labelled remove buttons', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<NamespaceMultiSelect namespaces={['a', 'b', 'c']} selected={['a', 'b']} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Remove a from the filter' }));
    expect(onChange).toHaveBeenCalledWith(['b']);
  });
});
