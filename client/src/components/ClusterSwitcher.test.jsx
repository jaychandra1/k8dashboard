import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ClusterSwitcher from './ClusterSwitcher';

const contexts = ['prod-eks', 'dev-aks', 'kind-local'];
const contextsInfo = [
  { name: 'prod-eks', provider: 'aws' },
  { name: 'dev-aks', provider: 'azure' },
  { name: 'kind-local', provider: 'local' },
];

const setup = (props = {}) => {
  const handlers = { onSwitch: vi.fn(), onTogglePin: vi.fn(), onOpenContexts: vi.fn(), onAddAws: vi.fn(), onAddAzure: vi.fn() };
  render(
    <ClusterSwitcher
      contexts={contexts}
      contextsInfo={contextsInfo}
      currentContext="prod-eks"
      pins={['prod-eks', 'dev-aks', 'gone-cluster']}
      {...handlers}
      {...props}
    />,
  );
  return { ...handlers, user: userEvent.setup() };
};
const trigger = () => screen.getByRole('button', { name: /Switch cluster/ });

describe('ClusterSwitcher', () => {
  it('shows the current context and opens a menu of pinned clusters with a check on the current one', async () => {
    const { user } = setup();
    const btn = trigger();
    expect(btn).toHaveTextContent('prod-eks');
    expect(btn).toHaveAttribute('aria-haspopup', 'menu');
    expect(btn).toHaveAttribute('aria-expanded', 'false');

    await user.click(btn);
    const menu = await screen.findByRole('menu', { name: 'Switch cluster' });
    expect(btn).toHaveAttribute('aria-expanded', 'true');

    // Pins that no longer exist in the kubeconfig are hidden.
    const pinned = within(menu).getAllByRole('menuitemcheckbox');
    expect(pinned.map((el) => el.textContent)).toEqual(['prod-eks', 'dev-aks']);
    expect(pinned[0]).toHaveAttribute('aria-checked', 'true');
    expect(pinned[1]).toHaveAttribute('aria-checked', 'false');

    expect(within(menu).getByRole('menuitem', { name: 'Unpin "prod-eks"' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /All contexts/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Add cluster' })).toHaveAttribute('aria-haspopup', 'menu');
  });

  it('selecting a pinned cluster switches; picking the current one is a no-op', async () => {
    const { user, onSwitch } = setup();
    await user.click(trigger());
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitemcheckbox', { name: 'dev-aks' }));
    expect(onSwitch).toHaveBeenCalledWith('dev-aks');
    expect(screen.queryByRole('menu')).toBeNull();

    await user.click(trigger());
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitemcheckbox', { name: 'prod-eks' }));
    expect(onSwitch).toHaveBeenCalledTimes(1);
  });

  it('offers Pin/Unpin for the current context, All contexts… and an Add cluster submenu', async () => {
    const { user, onTogglePin, onOpenContexts, onAddAws, onAddAzure } = setup({ pins: ['dev-aks'] });

    await user.click(trigger());
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Pin "prod-eks"' }));
    expect(onTogglePin).toHaveBeenCalledWith('prod-eks');

    await user.click(trigger());
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: /All contexts/ }));
    expect(onOpenContexts).toHaveBeenCalled();

    await user.click(trigger());
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Add cluster' }));
    const sub = await screen.findByRole('menu', { name: 'Add cluster' });
    expect(within(sub).getByRole('menuitem', { name: 'AWS EKS' })).toBeInTheDocument();
    await user.click(within(sub).getByRole('menuitem', { name: 'Azure AKS' }));
    expect(onAddAzure).toHaveBeenCalled();
    expect(onAddAws).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('shows a placeholder when nothing is pinned', async () => {
    const { user } = setup({ pins: [] });
    await user.click(trigger());
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryAllByRole('menuitemcheckbox')).toHaveLength(0);
    expect(within(menu).getByText('No pinned clusters')).toBeInTheDocument();
  });

  it('is keyboard operable: Enter opens, Escape closes and returns focus, ArrowDown opens', async () => {
    const { user } = setup();
    const btn = trigger();
    btn.focus();
    await user.keyboard('{Enter}');
    const menu = await screen.findByRole('menu');
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(btn);

    await user.keyboard('{ArrowDown}');
    expect(await screen.findByRole('menu')).toBeInTheDocument();
  });
});
