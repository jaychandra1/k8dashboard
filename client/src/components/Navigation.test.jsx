import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Navigation from './Navigation';

vi.mock('./CustomResourceTree', () => ({ default: () => <div data-testid="cr-tree" /> }));

describe('Navigation', () => {
  it('renders every item as a link and marks the active one with aria-current', () => {
    render(<Navigation view="pod" onNavigate={() => {}} argocdInstalled onOpenPreferences={() => {}} />);
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

  it('has no cluster logic of its own: without headerExtra the brand block is the whole header', () => {
    render(<Navigation view="pod" onNavigate={() => {}} onOpenPreferences={() => {}} />);
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).queryByRole('combobox')).toBeNull();
    expect(within(nav).queryByRole('listbox')).toBeNull();
    expect(within(nav).queryByRole('button', { name: /context|cluster/i })).toBeNull();
    expect(within(nav).queryByText(/^Context$/)).toBeNull();
    expect(nav.querySelector('.nav-context-selector, .nav-cluster, .ctx-search, .cluster-switcher')).toBeNull();
    const header = nav.querySelector('.nav-header');
    expect(header).toHaveTextContent('KubePilot');
    expect(within(header).getByRole('button', { name: 'Preferences' })).toBeInTheDocument();
    // Only the brand block lives in the header.
    expect(header.children).toHaveLength(1);
    expect(header.firstElementChild).toHaveClass('nav-brand');
  });

  it('renders headerExtra in the header, directly under the brand row', () => {
    render(
      <Navigation
        view="pod"
        onNavigate={() => {}}
        onOpenPreferences={() => {}}
        headerExtra={<div data-testid="extra"><button type="button">Switch cluster</button></div>}
      />,
    );
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const header = nav.querySelector('.nav-header');
    const extra = within(header).getByTestId('extra');
    expect(header.children).toHaveLength(2);
    expect(header.firstElementChild).toHaveClass('nav-brand');
    expect(header.lastElementChild).toBe(extra);
    expect(within(header).getByRole('button', { name: 'Switch cluster' })).toBeInTheDocument();
    // The slot sits above the scrolling sections.
    expect(header.compareDocumentPosition(nav.querySelector('.nav-sections')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('navigates via onNavigate on a plain click and toggles sections', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<Navigation view="overview" onNavigate={onNavigate} linkQuery={{ ns: 'default' }} onOpenPreferences={() => {}} />);
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
    render(<Navigation view="security" subView="images" onNavigate={() => {}} onOpenPreferences={() => {}} />);
    const active = screen.getAllByRole('link', { current: 'page' });
    expect(active).toHaveLength(1);
    expect(active[0]).toHaveTextContent('Images');
    expect(active[0]).toHaveAttribute('href', '#/security/images');
  });
});
