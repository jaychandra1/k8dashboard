import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ContextPickerModal from './ContextPickerModal';

const contexts = ['dev-env-cluster', 'pixdora-tech', 'tr-prod-cashierbackend'];
const contextsInfo = contexts.map((name) => ({ name, provider: 'aws' }));
const SLOW = { timeout: 5000 };

const setup = (props = {}) => {
  const handlers = {
    onClose: vi.fn(), onChange: vi.fn(), onRemove: vi.fn(),
    onAddAws: vi.fn(), onAddAzure: vi.fn(), onAddGke: vi.fn(), onAddLocal: vi.fn(), onDisconnect: vi.fn(),
  };
  render(<ContextPickerModal open contexts={contexts} contextsInfo={contextsInfo} currentContext="pixdora-tech" {...handlers} {...props} />);
  return { ...handlers, user: userEvent.setup() };
};

describe('the Switch cluster window', () => {
  it('lists every cluster under its provider with the connected one marked; picking one switches', async () => {
    const { user, onChange, onClose } = setup();
    const dlg = await screen.findByRole('dialog', { name: 'Switch cluster' }, SLOW);
    expect(within(dlg).getByRole('combobox', { name: 'Search clusters' })).toHaveAttribute('placeholder', 'Search 3 clusters…');
    const list = within(dlg).getByRole('listbox', { name: 'Clusters' });
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(contexts);
    expect(within(list).getByRole('option', { name: /pixdora-tech/ })).toHaveAttribute('aria-selected', 'true');
    expect(within(list).getByRole('group', { name: /AWS EKS/ })).toBeInTheDocument();
    await user.click(within(list).getByRole('option', { name: /dev-env-cluster/ }));
    expect(onChange).toHaveBeenCalledWith('dev-env-cluster');
    expect(onClose).toHaveBeenCalled();
  });

  it('picking the connected cluster only closes the window', async () => {
    const { user, onChange, onClose } = setup();
    await user.click(await screen.findByRole('option', { name: /pixdora-tech/ }, SLOW));
    expect(onChange).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('the list is searched and scrolls inside the window, so 40 clusters take the room 4 do', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `cluster-${String(i).padStart(2, '0')}`);
    const { user } = setup({ contexts: many, contextsInfo: many.map((name) => ({ name, provider: 'aws' })), currentContext: 'cluster-07' });
    const list = await screen.findByRole('listbox', { name: 'Clusters' }, SLOW);
    expect(within(list).getAllByRole('option')).toHaveLength(40);
    expect(list).toHaveClass('dd-list'); // max-height + overflow in App.css
    await user.type(screen.getByRole('combobox', { name: 'Search clusters' }), '-3');
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(many.filter((c) => c.includes('-3')));
  });

  it('Add a cluster: one row of the four ways, each asking the app to open its dialog', async () => {
    const { user, onAddAws, onAddAzure, onAddGke, onAddLocal, onChange } = setup();
    const add = await screen.findByRole('region', { name: 'Add a cluster' }, SLOW);
    const buttons = within(add).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['AWS EKS', 'Azure AKS', 'Google GKE', 'Kubeconfig']);
    // One row: as many equal columns as there are ways.
    expect(add.querySelector('.ctx-picker-add-row').style.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))');
    await user.click(buttons[0]);
    await user.click(buttons[1]);
    await user.click(buttons[2]);
    await user.click(buttons[3]);
    expect([onAddAws, onAddAzure, onAddGke, onAddLocal].map((f) => f.mock.calls.length)).toEqual([1, 1, 1, 1]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('only the ways the app offers are shown; none: no "Add a cluster" at all', async () => {
    const { unmount } = render(<ContextPickerModal open contexts={contexts} contextsInfo={contextsInfo} currentContext="pixdora-tech" onClose={() => {}} onAddAws={() => {}} onAddLocal={() => {}} />);
    const add = await screen.findByRole('region', { name: 'Add a cluster' }, SLOW);
    expect(within(add).getAllByRole('button').map((b) => b.textContent)).toEqual(['AWS EKS', 'Kubeconfig']);
    expect(add.querySelector('.ctx-picker-add-row').style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))');
    unmount();
    render(<ContextPickerModal open contexts={contexts} contextsInfo={contextsInfo} currentContext="pixdora-tech" onClose={() => {}} />);
    await screen.findByRole('listbox', { name: 'Clusters' }, SLOW);
    expect(screen.queryByRole('region', { name: 'Add a cluster' })).toBeNull();
  });

  it('Disconnect is at the bottom, next to the cluster it leaves', async () => {
    const { user, onDisconnect } = setup();
    const dlg = await screen.findByRole('dialog', { name: 'Switch cluster' }, SLOW);
    expect(dlg).toHaveTextContent('Connected to pixdora-tech');
    await user.click(within(dlg).getByRole('button', { name: 'Disconnect' }));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('there is no pinning anywhere in it', async () => {
    setup();
    const dlg = await screen.findByRole('dialog', { name: 'Switch cluster' }, SLOW);
    expect(dlg).not.toHaveTextContent(/pin/i);
    expect(within(dlg).queryByRole('button', { name: /pin/i })).toBeNull();
  });
});

describe('the Switch cluster window: removing a cluster', () => {
  it("each row's remove button asks for removal without switching to it", async () => {
    const { user, onRemove, onChange } = setup();
    const list = await screen.findByRole('listbox', { name: 'Clusters' }, SLOW);
    const row = within(list).getByRole('option', { name: /tr-prod-cashierbackend/ });
    await user.click(within(row).getByRole('button', { name: 'Remove tr-prod-cashierbackend' }));
    // The app opens the confirmation in the window's place (and comes back to it on Cancel).
    expect(onRemove).toHaveBeenCalledWith('tr-prod-cashierbackend');
    expect(onChange).not.toHaveBeenCalled();
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
    await screen.findByRole('listbox', { name: 'Clusters' }, SLOW);
    expect(screen.queryByRole('button', { name: 'Remove dev-env-cluster' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove pixdora-tech' })).toBeInTheDocument();
  });
});

describe('the Switch cluster window: keyboard', () => {
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
