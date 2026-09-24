import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ClusterSwitcher, { MAX_INLINE } from './ClusterSwitcher';

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
  it('shows the current context and opens a menu: pinned clusters, then every context under "All contexts"', async () => {
    const { user } = setup();
    const btn = trigger();
    expect(btn).toHaveTextContent('prod-eks');
    expect(btn).toHaveAttribute('aria-haspopup', 'menu');
    expect(btn).toHaveAttribute('aria-expanded', 'false');

    await user.click(btn);
    const menu = await screen.findByRole('menu', { name: 'Switch cluster' });
    expect(btn).toHaveAttribute('aria-expanded', 'true');

    // Pins that no longer exist in the kubeconfig are hidden; then (≤ MAX_INLINE
    // contexts) the full list follows a non-interactive "All contexts" heading.
    const checks = within(menu).getAllByRole('menuitemcheckbox');
    expect(checks.map((el) => el.textContent)).toEqual(['prod-eks', 'dev-aks', 'dev-aks', 'kind-local', 'prod-eks']);
    expect(checks[0]).toHaveAttribute('aria-checked', 'true');
    expect(checks[1]).toHaveAttribute('aria-checked', 'false');
    expect(checks[4]).toHaveAttribute('aria-checked', 'true'); // prod-eks again, in the all-contexts group
    const heading = within(menu).getByText('All contexts');
    expect(heading.closest('.ui-menu-heading')).toHaveTextContent('3');
    expect(within(menu).queryByRole('menuitem', { name: /All contexts/ })).toBeNull();

    expect(within(menu).getByRole('menuitem', { name: 'Search contexts…' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Unpin "prod-eks"' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Add cluster' })).toHaveAttribute('aria-haspopup', 'menu');
    expect(within(menu).getAllByRole('separator')).toHaveLength(2);
  });

  it('selecting a pinned or listed cluster switches; picking the current one is a no-op', async () => {
    const { user, onSwitch } = setup({ pins: ['prod-eks'] });
    await user.click(trigger());
    // kind-local is not pinned: it is only reachable through the all-contexts group.
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitemcheckbox', { name: 'kind-local' }));
    expect(onSwitch).toHaveBeenCalledWith('kind-local');
    expect(screen.queryByRole('menu')).toBeNull();

    await user.click(trigger());
    await user.click(within(await screen.findByRole('menu')).getAllByRole('menuitemcheckbox', { name: 'prod-eks' })[0]);
    expect(onSwitch).toHaveBeenCalledTimes(1);
  });

  it('moves the contexts into an "All contexts" submenu when there are more than MAX_INLINE', async () => {
    const many = Array.from({ length: MAX_INLINE + 1 }, (_, i) => `cluster-${String(i).padStart(2, '0')}`);
    const { user, onSwitch } = setup({ contexts: many, contextsInfo: [], currentContext: 'cluster-00', pins: [] });
    await user.click(trigger());
    const menu = await screen.findByRole('menu', { name: 'Switch cluster' });
    expect(within(menu).queryAllByRole('menuitemcheckbox')).toHaveLength(0);
    const all = within(menu).getByRole('menuitem', { name: /All contexts/ });
    expect(all).toHaveAttribute('aria-haspopup', 'menu');
    expect(all).toHaveTextContent(String(MAX_INLINE + 1));
    expect(within(menu).getByRole('menuitem', { name: 'Search contexts…' })).toBeInTheDocument();

    await user.click(all);
    const sub = await screen.findByRole('menu', { name: 'All contexts' });
    const items = within(sub).getAllByRole('menuitemcheckbox');
    expect(items).toHaveLength(MAX_INLINE + 1);
    expect(items[0]).toHaveAttribute('aria-checked', 'true');
    await user.click(within(sub).getByRole('menuitemcheckbox', { name: 'cluster-05' }));
    expect(onSwitch).toHaveBeenCalledWith('cluster-05');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('offers Pin/Unpin for the current context, Search contexts… (opens the picker) and an Add cluster submenu', async () => {
    const { user, onTogglePin, onOpenContexts, onAddAws, onAddAzure } = setup({ pins: ['dev-aks'] });

    await user.click(trigger());
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Pin "prod-eks"' }));
    expect(onTogglePin).toHaveBeenCalledWith('prod-eks');

    await user.click(trigger());
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Search contexts…' }));
    expect(onOpenContexts).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();

    await user.click(trigger());
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Add cluster' }));
    const sub = await screen.findByRole('menu', { name: 'Add cluster' });
    expect(within(sub).getByRole('menuitem', { name: 'AWS EKS' })).toBeInTheDocument();
    await user.click(within(sub).getByRole('menuitem', { name: 'Azure AKS' }));
    expect(onAddAzure).toHaveBeenCalled();
    expect(onAddAws).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('variant="sidebar" renders the same button and menu as a full-width sidebar row', async () => {
    const { user, onSwitch } = setup({ variant: 'sidebar' });
    const btn = trigger();
    const root = btn.closest('.cluster-switcher');
    expect(root).toHaveClass('cluster-switcher--sidebar');
    expect(btn).toHaveClass('cluster-switcher-btn');
    expect(btn).toHaveTextContent('prod-eks');
    expect(btn.querySelector('.cluster-switcher-name')).toHaveTextContent('prod-eks');
    expect(btn.querySelector('.cluster-switcher-caret')).not.toBeNull();
    // Same menu, same behaviour.
    await user.click(btn);
    const menu = await screen.findByRole('menu', { name: 'Switch cluster' });
    expect(within(menu).getAllByRole('menuitemcheckbox').map((el) => el.textContent)).toEqual(['prod-eks', 'dev-aks', 'dev-aks', 'kind-local', 'prod-eks']);
    await user.click(within(menu).getByRole('menuitemcheckbox', { name: 'kind-local' }));
    expect(onSwitch).toHaveBeenCalledWith('kind-local');
    expect(screen.queryByRole('menu')).toBeNull();
    // The default variant carries no sidebar modifier.
    document.body.innerHTML = '';
    setup();
    expect(trigger().closest('.cluster-switcher')).not.toHaveClass('cluster-switcher--sidebar');
  });

  it('shows a placeholder when nothing is pinned (the all-contexts list still works)', async () => {
    const { user } = setup({ pins: [] });
    await user.click(trigger());
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('No pinned clusters')).toBeInTheDocument();
    expect(within(menu).getAllByRole('menuitemcheckbox').map((el) => el.textContent)).toEqual(['dev-aks', 'kind-local', 'prod-eks']);
  });

  it('is keyboard operable: Enter opens, headings are skipped, Escape closes and returns focus, ArrowDown opens', async () => {
    const { user } = setup({ pins: [] });
    const btn = trigger();
    btn.focus();
    await user.keyboard('{Enter}');
    const menu = await screen.findByRole('menu');
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
    // First enabled item ("No pinned clusters" is disabled, the heading is not focusable) → dev-aks.
    await waitFor(() => expect(within(menu).getByRole('menuitemcheckbox', { name: 'dev-aks' })).toHaveClass('active'));

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(btn);

    await user.keyboard('{ArrowDown}');
    expect(await screen.findByRole('menu')).toBeInTheDocument();
  });
});
