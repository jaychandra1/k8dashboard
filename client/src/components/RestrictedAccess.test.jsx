// A user who was given part of a cluster (a Role in a namespace or two, and
// nothing cluster-wide): they add their namespace by name, lists say "no
// access" for what isn't theirs, and nothing reads as a failure.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor, cleanup, act, fireEvent } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NamespaceMultiSelect from './NamespaceMultiSelect';
import ResourceViewer from './ResourceViewer';
import Cluster from './Cluster';
import Namespaces from './Namespaces';
import ErrorState from './ui/ErrorState';
import { ToastProvider } from './Toast';
import { NamespaceAccessProvider, AddNamespaceForm, RESTRICTED_HINT } from './shell/NamespaceAccess';
import useNamespaces from './shell/useNamespaces';
import useResourceFanOut from './shell/useResourceFanOut';

vi.mock('../lib/api', async (orig) => {
  const actual = await orig();
  return { ...actual, getJson: vi.fn(), postJson: vi.fn(), del: vi.fn() };
});
import { getJson, postJson, del, ApiError } from '../lib/api';

const SLOW = { timeout: 5000 };
const noAccess = (name) => new ApiError({ status: 403, code: 'no_access', message: `You have no access to a namespace named "${name}" on this cluster. Check the name, or ask your cluster administrator.` });
const forbidden = (message) => new ApiError({ status: 403, code: 'forbidden', message });

/** The shell's side: a list that `add` grows, as the server would. */
function accessWith(initial = [], { restricted = true } = {}) {
  const state = { restricted, namespaces: [...initial] };
  state.add = vi.fn(async (name) => {
    if (name === 'prodenv') throw noAccess(name);
    state.namespaces = [...state.namespaces, name];
  });
  state.remove = vi.fn(async (name) => { state.namespaces = state.namespaces.filter((n) => n !== name); });
  return state;
}
const within$ = (access, ui) => render(<ToastProvider><NamespaceAccessProvider value={access}>{ui}</NamespaceAccessProvider></ToastProvider>);

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });
afterEach(() => cleanup());

describe('adding a namespace by name', () => {
  it('adds what was typed (trimmed, lower case) and reports it; the field empties', async () => {
    const access = accessWith();
    const onAdded = vi.fn();
    const user = userEvent.setup();
    within$(access, <AddNamespaceForm onAdded={onAdded} />);
    const field = screen.getByRole('textbox', { name: 'Namespace name' });
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    await user.type(field, '  QAenv {Enter}');
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('qaenv'));
    expect(access.add).toHaveBeenCalledWith('qaenv');
    expect(field).toHaveValue('');
  });

  it('a namespace the user has nothing in: the reason, on the field, and nothing is reported', async () => {
    const access = accessWith();
    const onAdded = vi.fn();
    const user = userEvent.setup();
    within$(access, <AddNamespaceForm onAdded={onAdded} />);
    const field = screen.getByRole('textbox', { name: 'Namespace name' });
    await user.type(field, 'prodenv');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('You have no access to a namespace named "prodenv" on this cluster.');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription(/no access to a namespace named "prodenv"/);
    expect(field).toHaveValue('prodenv');
    expect(onAdded).not.toHaveBeenCalled();
    // Typing again clears it.
    await user.type(field, 'x');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the namespace picker', () => {
  it('someone who can list namespaces sees no "add" field', async () => {
    const user = userEvent.setup();
    within$(accessWith(['a', 'b'], { restricted: false }), <NamespaceMultiSelect namespaces={['a', 'b']} selected={['all']} onChange={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Namespaces: All namespaces' }));
    expect(screen.getByRole('option', { name: 'All namespaces' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Namespace name' })).toBeNull();
    expect(screen.queryByText(RESTRICTED_HINT)).toBeNull();
  });

  it('nothing added yet: it says so, opens on the field, and the new namespace is selected', async () => {
    const access = accessWith();
    const onChange = vi.fn();
    const user = userEvent.setup();
    within$(access, <NamespaceMultiSelect namespaces={[]} selected={['all']} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Namespaces: Add a namespace' }));
    expect(screen.getByText(RESTRICTED_HINT)).toBeInTheDocument();
    const field = screen.getByRole('textbox', { name: 'Namespace name' });
    expect(field).toHaveFocus();
    await user.type(field, 'qaenv{Enter}');
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(['qaenv']));
    // Typing a name is not typing in the list: nothing was toggled.
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('with namespaces: "all" is all of theirs; one namespace is named; another can be added to the selection', async () => {
    const access = accessWith(['qaenv']);
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = within$(access, <NamespaceMultiSelect namespaces={['qaenv']} selected={['all']} onChange={onChange} />);
    // One namespace is all there is: the button names it.
    await user.click(screen.getByRole('button', { name: 'Namespaces: qaenv' }));
    expect(screen.getByRole('option', { name: 'All my namespaces' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'qaenv' })).toBeInTheDocument();
    // The field is outside the listbox (a listbox holds options only).
    expect(within(screen.getByRole('listbox')).queryByRole('textbox')).toBeNull();
    await user.keyboard('{Escape}');
    // Closed, wherever the focus was when Escape came (see the next test).
    expect(screen.queryByRole('listbox')).toBeNull();

    rerender(<ToastProvider><NamespaceAccessProvider value={access}><NamespaceMultiSelect namespaces={['qaenv', 'stage']} selected={['qaenv']} onChange={onChange} /></NamespaceAccessProvider></ToastProvider>);
    await user.click(screen.getByRole('button', { name: 'Namespaces: qaenv' }));
    await user.type(await screen.findByRole('textbox', { name: 'Namespace name' }), 'team-b{Enter}');
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(['qaenv', 'team-b']));
  });

  // The list takes the focus a moment after the picker opens (after the next
  // paint). Escape pressed before that arrives at the button, and used to be
  // ignored there: the picker stayed open.
  it('Escape closes the picker while the focus is still on its button', async () => {
    const user = userEvent.setup();
    within$(accessWith(['qaenv']), <NamespaceMultiSelect namespaces={['qaenv']} selected={['all']} onChange={() => {}} />);
    const trigger = screen.getByRole('button', { name: 'Namespaces: qaenv' });
    await user.click(trigger);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    // Escape on the button itself, as when it is pressed before the list took the focus.
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // …and the next click opens it (it does not close a picker left open).
    await user.click(trigger);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  // …and the other half of that moment: someone already in the "add" field
  // when the list would take the focus keeps it (their typing stays in the field).
  it('the list does not take the focus away from the "add" field', async () => {
    const user = userEvent.setup();
    within$(accessWith(['qaenv']), <NamespaceMultiSelect namespaces={['qaenv']} selected={['all']} onChange={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Namespaces: qaenv' }));
    const field = screen.getByRole('textbox', { name: 'Namespace name' });
    act(() => field.focus());
    // Well past the paint after which the list focuses itself.
    await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
    expect(field).toHaveFocus();
    expect(screen.getByRole('listbox')).not.toHaveFocus();
  });

  it('keyboard: Tab goes from the list to the field, Escape there closes the picker', async () => {
    const user = userEvent.setup();
    within$(accessWith(['qaenv']), <NamespaceMultiSelect namespaces={['qaenv']} selected={['all']} onChange={() => {}} />);
    const trigger = screen.getByRole('button', { name: 'Namespaces: qaenv' });
    await user.click(trigger);
    // The list takes the focus after the next paint: wait for it, however long that is here.
    await waitFor(() => expect(screen.getByRole('listbox')).toHaveFocus());
    await user.tab();
    expect(screen.getByRole('textbox', { name: 'Namespace name' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger).toHaveFocus();
  });
});

describe('the shell: namespaces of a user who may not list them', () => {
  it('reads "restricted" and the list; add and remove show the server\'s new list at once', async () => {
    getJson.mockResolvedValue({ namespaces: [], details: [], restricted: true });
    postJson.mockResolvedValue({ namespaces: ['qaenv'], added: 'qaenv', verified: true });
    del.mockResolvedValue({ namespaces: [], removed: 'qaenv' });
    const toast = { error: vi.fn() };
    const { result } = renderHook(() => useNamespaces({ contextKey: 'qa-eks', toast }));
    await waitFor(() => expect(result.current.restricted).toBe(true));
    expect(result.current.namespaces).toEqual([]);
    await act(async () => { await result.current.add('qaenv'); });
    expect(postJson).toHaveBeenCalledWith('/api/namespaces/known', { name: 'qaenv' });
    expect(result.current.namespaces).toEqual(['qaenv']);
    expect(getJson).toHaveBeenCalledTimes(1);
    await act(async () => { await result.current.remove('qaenv'); });
    expect(del).toHaveBeenCalledWith('/api/namespaces/known/qaenv');
    expect(result.current.namespaces).toEqual([]);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('a refused namespace rejects (the form shows why) and changes nothing', async () => {
    getJson.mockResolvedValue({ namespaces: ['qaenv'], restricted: true });
    postJson.mockRejectedValue(noAccess('prodenv'));
    const { result } = renderHook(() => useNamespaces({ contextKey: 'qa-eks' }));
    await waitFor(() => expect(result.current.namespaces).toEqual(['qaenv']));
    await expect(result.current.add('prodenv')).rejects.toThrow(/no access/);
    expect(result.current.namespaces).toEqual(['qaenv']);
  });

  it('an ordinary cluster: not restricted', async () => {
    getJson.mockResolvedValue({ namespaces: ['default', 'kube-system'], details: [] });
    const { result } = renderHook(() => useNamespaces({ contextKey: 'dev' }));
    await waitFor(() => expect(result.current.namespaces).toEqual(['default', 'kube-system']));
    expect(result.current.restricted).toBe(false);
  });
});

describe('loading the lists', () => {
  const PARTIAL = {
    pods: [{ name: 'orders-api-1', namespace: 'qaenv' }], services: [],
    partial: true, errors: [{ kind: 'services', error: 'no permission', forbidden: true }, { kind: 'jobs', error: 'connection timed out' }],
  };

  it('what the user may not list is marked as such, per kind and per namespace', async () => {
    getJson.mockImplementation(async (url) => {
      if (url === '/api/resources/qaenv') return PARTIAL;
      throw forbidden("You don't have permission to list pods in namespace prodenv.");
    });
    const { result } = renderHook(() => useResourceFanOut({ contextKey: 'c', view: 'pod', selectedNamespaces: ['all'], allNamespaces: ['qaenv', 'prodenv'] }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.allResources.pods).toHaveLength(1);
    expect(result.current.partialErrors).toEqual(expect.arrayContaining([
      { kind: 'services', error: 'no permission', namespace: 'qaenv', forbidden: true },
      { kind: 'jobs', error: 'connection timed out', namespace: 'qaenv' },
      { kind: '*', namespace: 'prodenv', error: "You don't have permission to list pods in namespace prodenv.", forbidden: true },
    ]));
  });

  it('allowed nowhere it asked: an answer ("no access"), not an error', async () => {
    getJson.mockRejectedValue(forbidden("You don't have permission to list pods in namespace prodenv."));
    const { result } = renderHook(() => useResourceFanOut({ contextKey: 'c', view: 'pod', selectedNamespaces: ['prodenv'], allNamespaces: [] }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.partialErrors).toEqual([{ kind: '*', namespace: 'prodenv', error: "You don't have permission to list pods in namespace prodenv.", forbidden: true }]);
  });

  it('a namespace that fails for another reason is still a failure', async () => {
    getJson.mockRejectedValue(new ApiError({ status: 502, code: 'upstream_error', message: 'connection timed out' }));
    const { result } = renderHook(() => useResourceFanOut({ contextKey: 'c', view: 'pod', selectedNamespaces: ['qaenv'], allNamespaces: [] }));
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.error.code).toBe('fanout_failed');
  });
});

describe('a resource list', () => {
  const viewer = (access, props) => within$(access, (
    <ResourceViewer resourceType="service" resources={[]} namespaces={access.namespaces} selectedNamespaces={['qaenv']} onNamespaceChange={() => {}} onAction={() => {}} {...props} />
  ));
  beforeEach(() => { getJson.mockResolvedValue({ metrics: {} }); });

  it('a kind the user may not list: "No access", who to ask — and no "could not be loaded" banner', () => {
    viewer(accessWith(['qaenv']), { partialErrors: [{ kind: 'services', namespace: 'qaenv', error: 'no permission', forbidden: true }, { kind: 'jobs', namespace: 'qaenv', error: 'no permission', forbidden: true }] });
    expect(screen.getByText('No access to services')).toBeInTheDocument();
    expect(screen.getByText('Your sign-in isn’t allowed to list services in namespace qaenv. Ask your cluster administrator if you need it.')).toBeInTheDocument();
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
    expect(screen.queryByText('No services found')).toBeNull();
  });

  it('a kind they may list that is empty still says "none found"; a real failure still shows the banner', () => {
    viewer(accessWith(['qaenv']), { partialErrors: [{ kind: 'jobs', namespace: 'qaenv', error: 'no permission', forbidden: true }, { kind: 'ingresses', namespace: 'qaenv', error: 'connection timed out' }] });
    expect(screen.getByText('No services found')).toBeInTheDocument();
    expect(screen.queryByText('No access to services')).toBeNull();
    expect(screen.getByText('Some kinds could not be loaded: ingresses (connection timed out)')).toBeInTheDocument();
  });

  it('allowed in one of two namespaces: not "no access" (the rows of the other are the list)', () => {
    viewer(accessWith(['qaenv', 'stage']), { selectedNamespaces: ['all'], partialErrors: [{ kind: 'services', namespace: 'stage', error: 'no permission', forbidden: true }] });
    expect(screen.queryByText('No access to services')).toBeNull();
    expect(screen.getByText('No services in your namespaces. Try selecting another namespace.')).toBeInTheDocument();
  });

  it('a namespace the user has nothing in at all', () => {
    viewer(accessWith(['qaenv'], { restricted: false }), { selectedNamespaces: ['prodenv'], partialErrors: [{ kind: '*', namespace: 'prodenv', error: 'x', forbidden: true }] });
    expect(screen.getByText('No access to services')).toBeInTheDocument();
    expect(screen.getByText(/isn’t allowed to list services in namespace prodenv/)).toBeInTheDocument();
  });

  it('no namespace yet: the list asks for it, and opens on the one that is added', async () => {
    const access = accessWith();
    const onNamespaceChange = vi.fn();
    const user = userEvent.setup();
    viewer(access, { selectedNamespaces: ['all'], onNamespaceChange });
    expect(screen.getByText('Add your namespace')).toBeInTheDocument();
    const empty = screen.getByText('Add your namespace').closest('.ui-empty');
    await user.type(within(empty).getByRole('textbox', { name: 'Namespace name' }), 'qaenv{Enter}');
    await waitFor(() => expect(onNamespaceChange).toHaveBeenCalledWith(['qaenv']));
  });
});

describe('the Dashboard of a sign-in that sees part of the cluster', () => {
  const LIMITED = { currentContext: 'qa-eks', serverVersion: 'v1.33.4', platform: 'linux/amd64', limited: true };
  beforeEach(() => { getJson.mockResolvedValue(LIMITED); });

  it('no failed summary: it says what this is, and asks for the namespace', async () => {
    const access = accessWith();
    const onOpenNamespace = vi.fn();
    const onSummaryLoaded = vi.fn();
    const user = userEvent.setup();
    within$(access, <Cluster context="qa-eks" onOpen={() => {}} onOpenNamespace={onOpenNamespace} onSummaryLoaded={onSummaryLoaded} />);
    expect(await screen.findByRole('heading', { name: 'You have access to part of this cluster' }, SLOW)).toBeInTheDocument();
    expect(screen.getByText('v1.33.4')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
    // The shell's "connecting…" screen ends on this, as on a full summary.
    expect(onSummaryLoaded).toHaveBeenCalledWith('qa-eks');
    expect(screen.getByRole('heading', { name: 'Add your namespace' })).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Namespace name' }), 'qaenv{Enter}');
    await waitFor(() => expect(onOpenNamespace).toHaveBeenCalledWith('qaenv'));
  });

  it('with namespaces: each opens, and another can be added', async () => {
    const onOpenNamespace = vi.fn();
    const user = userEvent.setup();
    within$(accessWith(['qaenv', 'stage']), <Cluster context="qa-eks" onOpen={() => {}} onOpenNamespace={onOpenNamespace} />);
    await screen.findByRole('heading', { name: 'Your namespaces' }, SLOW);
    expect(screen.getByRole('heading', { name: 'Add another namespace' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open namespace stage' }));
    expect(onOpenNamespace).toHaveBeenCalledWith('stage');
  });

  it('may list namespaces, but nothing cluster-wide: straight to the list of namespaces', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    within$(accessWith(['default', 'qaenv'], { restricted: false }), <Cluster context="qa-eks" onOpen={onOpen} />);
    await user.click(await screen.findByRole('button', { name: 'Browse namespaces' }, SLOW));
    expect(onOpen).toHaveBeenCalledWith('namespaces');
    expect(screen.queryByRole('textbox', { name: 'Namespace name' })).toBeNull();
  });
});

describe('the Namespaces page', () => {
  it('lists the namespaces the user added, with a way to add and to remove', async () => {
    getJson.mockResolvedValue({ namespaces: ['qaenv'], details: [{ name: 'qaenv', status: 'Active', createdAt: null, labels: {} }], restricted: true });
    const access = accessWith(['qaenv']);
    const user = userEvent.setup();
    within$(access, <Namespaces onNavigate={{ toNamespace: () => {} }} />);
    expect(await screen.findByText(RESTRICTED_HINT, {}, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Namespace name' })).toBeInTheDocument();
    expect(await screen.findByText('qaenv')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Actions for qaenv' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove from my namespaces' }));
    expect(access.remove).toHaveBeenCalledWith('qaenv');
  });

  it('an ordinary cluster: the plain list, nothing to add or remove', async () => {
    getJson.mockResolvedValue({ namespaces: ['default'], details: [{ name: 'default', status: 'Active', createdAt: '2024-01-01T00:00:00Z', labels: {} }] });
    within$(accessWith(['default'], { restricted: false }), <Namespaces onNavigate={{ toNamespace: () => {} }} />);
    expect(await screen.findByText('default', {}, SLOW)).toBeInTheDocument();
    expect(screen.queryByText(RESTRICTED_HINT)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Actions for default' })).toBeNull();
  });
});

describe('"you aren\'t allowed to" is not shown as a failure', () => {
  it('no alarm: title "No access", the sentence, no HTTP status, "Check again"', () => {
    render(<ErrorState error={forbidden("You don't have permission to list nodes.")} title="Couldn't load nodes" onRetry={() => {}} />);
    const box = screen.getByRole('status');
    expect(box).toHaveTextContent('No access');
    expect(box).toHaveTextContent("You don't have permission to list nodes.");
    expect(box).not.toHaveTextContent('HTTP 403');
    expect(box).not.toHaveTextContent("Couldn't load nodes");
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
  });

  it('a view that words the refusal itself keeps its title', () => {
    render(<ErrorState error={forbidden("You don't have permission to list vulnerabilityreports.")} title="Your RBAC role can't read vulnerability reports" />);
    const box = screen.getByRole('status');
    expect(box).toHaveTextContent("Your RBAC role can't read vulnerability reports");
    expect(box).not.toHaveTextContent('No access');
  });

  it('a real failure is unchanged', () => {
    render(<ErrorState error={new ApiError({ status: 502, code: 'upstream_error', message: 'connection timed out' })} title="Couldn't load nodes" onRetry={() => {}} />);
    const box = screen.getByRole('alert');
    expect(box).toHaveTextContent("Couldn't load nodes");
    expect(box).toHaveTextContent('connection timed out (HTTP 502)');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
