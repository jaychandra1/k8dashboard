import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ContextPickerModal from './ContextPickerModal';

const contexts = ['dev-env-cluster', 'pixdora-tech', 'tr-prod-cashierbackend'];
const contextsInfo = contexts.map((name) => ({ name, provider: 'aws' }));
const SLOW = { timeout: 5000 };

const setup = (props = {}) => {
  const handlers = { onClose: vi.fn(), onChange: vi.fn(), onRemove: vi.fn() };
  render(<ContextPickerModal open contexts={contexts} contextsInfo={contextsInfo} currentContext="pixdora-tech" {...handlers} {...props} />);
  return { ...handlers, user: userEvent.setup() };
};

describe('ContextPickerModal: removing a cluster', () => {
  it("each row's remove button asks for removal without switching to it", async () => {
    const { user, onRemove, onChange, onClose } = setup();
    const list = await screen.findByRole('listbox', { name: 'All contexts' }, SLOW);
    const row = within(list).getByRole('option', { name: /tr-prod-cashierbackend/ });
    await user.click(within(row).getByRole('button', { name: 'Remove tr-prod-cashierbackend' }));
    expect(onRemove).toHaveBeenCalledWith('tr-prod-cashierbackend');
    expect(onChange).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled(); // the confirmation opens on its own
  });

  it('Shift+Delete removes the keyboard-active row; plain Delete keeps editing the search', async () => {
    const { user, onRemove } = setup();
    const search = await screen.findByRole('combobox', {}, SLOW);
    await user.click(search);
    await user.keyboard('{ArrowDown}'); // pixdora-tech (current) → tr-prod-cashierbackend
    await user.keyboard('{Delete}');
    expect(onRemove).not.toHaveBeenCalled();
    await user.keyboard('{Shift>}{Delete}{/Shift}');
    expect(onRemove).toHaveBeenCalledWith('tr-prod-cashierbackend');
  });

  it('no remove buttons without onRemove, or where canRemove says no', async () => {
    const { unmount } = render(<ContextPickerModal open contexts={contexts} contextsInfo={contextsInfo} currentContext="pixdora-tech" onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    unmount();
    setup({ canRemove: (ctx) => ctx !== 'dev-env-cluster' });
    await screen.findByRole('listbox', { name: 'All contexts' }, SLOW);
    expect(screen.queryByRole('button', { name: 'Remove dev-env-cluster' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove pixdora-tech' })).toBeInTheDocument();
  });
});

describe('ContextPickerModal: keyboard', () => {
  it('↑/↓ move the highlight away from the current cluster (it used to snap back)', async () => {
    const { user, onChange } = setup();
    const search = await screen.findByRole('combobox', {}, SLOW);
    await user.click(search);
    expect(search.getAttribute('aria-activedescendant')).toMatch(/pixdora-tech$/);
    await user.keyboard('{ArrowDown}');
    expect(search.getAttribute('aria-activedescendant')).toMatch(/tr-prod-cashierbackend$/);
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(search.getAttribute('aria-activedescendant')).toMatch(/dev-env-cluster$/);
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('dev-env-cluster');
  });
});
