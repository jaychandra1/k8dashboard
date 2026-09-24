import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Navigation from './Navigation';

vi.mock('./CustomResourceTree', () => ({ default: () => <div data-testid="cr-tree" /> }));

const configStatus = { contexts: ['dev', 'prod'], contextsInfo: [{ name: 'dev', provider: 'local' }], currentContext: 'dev' };

describe('Navigation', () => {
  it('renders every item as a link and marks the active one with aria-current', () => {
    render(<Navigation configStatus={configStatus} view="pod" onNavigate={() => {}} onSwitchContext={() => {}} argocdInstalled onOpenPreferences={() => {}} />);
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(nav).toHaveAttribute('id', 'primary-nav');
    // No clickable divs: every navigation item is an anchor with an #/… href.
    const links = within(nav).getAllByRole('link');
    expect(links.length).toBeGreaterThan(10);
    links.forEach((a) => expect(a.getAttribute('href')).toMatch(/^#\//));
    const active = within(nav).getAllByRole('link', { current: 'page' });
    expect(active).toHaveLength(1);
    expect(active[0]).toHaveTextContent('Pods');
    expect(active[0]).toHaveAttribute('href', '#/pod');
    // Section headers are disclosure buttons.
    const workloads = within(nav).getByRole('button', { name: 'Workloads' });
    expect(workloads).toHaveAttribute('aria-expanded', 'true');
    expect(within(nav).getByRole('button', { name: 'Preferences' })).toBeInTheDocument();
    expect(within(nav).queryAllByRole('generic').filter((el) => el.className === 'nav-item')).toHaveLength(0);
  });

  it('navigates via onNavigate on a plain click and toggles sections', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<Navigation configStatus={configStatus} view="overview" onNavigate={onNavigate} onSwitchContext={() => {}} linkQuery={{ ns: 'default' }} onOpenPreferences={() => {}} />);
    const nodes = screen.getByRole('link', { name: 'Nodes' });
    expect(nodes).toHaveAttribute('href', '#/nodes?ns=default');
    await user.click(nodes);
    expect(onNavigate).toHaveBeenCalledWith('nodes', undefined);
    const network = screen.getByRole('button', { name: 'Network' });
    expect(network).toHaveAttribute('aria-expanded', 'false');
    await user.click(network);
    expect(network).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Services' })).toHaveAttribute('href', '#/service?ns=default');
  });

  it('marks argo / security sub-views active from subView', () => {
    render(<Navigation configStatus={configStatus} view="security" subView="images" onNavigate={() => {}} onSwitchContext={() => {}} onOpenPreferences={() => {}} />);
    const active = screen.getAllByRole('link', { current: 'page' });
    expect(active).toHaveLength(1);
    expect(active[0]).toHaveTextContent('Images');
    expect(active[0]).toHaveAttribute('href', '#/security/images');
  });
});
