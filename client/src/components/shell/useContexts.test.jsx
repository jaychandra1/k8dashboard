import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { _resetHistoryIndex } from '../../hooks/useHashRoute';

const api = vi.hoisted(() => ({ postJson: vi.fn() }));
vi.mock('../../lib/api', async (orig) => {
  const real = await orig();
  return { ...real, postJson: api.postJson };
});

import useContexts, { POST_SWITCH_VIEW } from './useContexts';

const makeGate = (over = {}) => ({
  configStatus: { currentContext: 'alpha', contexts: ['alpha', 'beta'] },
  fetchConfigStatus: vi.fn(async () => ({ currentContext: 'beta' })),
  checkAuth: vi.fn(async () => true),
  ...over,
});
const makeToast = () => ({ success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() });

describe('useContexts', () => {
  beforeEach(() => {
    _resetHistoryIndex();
    window.location.hash = '#/pod/default/web?ns=default';
    api.postJson.mockReset();
  });

  it('switchContext POSTs, lands on the Cluster overview and exposes `switching` until auth is re-checked', async () => {
    let release;
    api.postJson.mockImplementation(() => new Promise((r) => { release = r; }));
    const gate = makeGate();
    const toast = makeToast();
    const { result } = renderHook(() => useContexts({ gate, toast }));
    expect(POST_SWITCH_VIEW).toBe('cluster');
    expect(result.current.switching).toBe(false);

    let done;
    act(() => { done = result.current.switchContext('beta'); });
    expect(result.current.switching).toBe(true);
    expect(result.current.switchTarget).toBe('beta');
    expect(api.postJson).toHaveBeenCalledWith('/api/config/context', { contextName: 'beta' });
    // Still on the old route while the POST is in flight.
    expect(window.location.hash).toBe('#/pod/default/web?ns=default');

    await act(async () => { release({}); await done; });
    expect(window.location.hash).toBe('#/cluster');
    expect(gate.fetchConfigStatus).toHaveBeenCalled();
    expect(gate.checkAuth).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Switched to beta', { title: 'Cluster' });
    await waitFor(() => expect(result.current.switching).toBe(false));
    expect(result.current.switchTarget).toBe('beta');
  });

  it('is a no-op for the current context or an empty name', async () => {
    const { result } = renderHook(() => useContexts({ gate: makeGate(), toast: makeToast() }));
    await act(async () => {
      expect(await result.current.switchContext('alpha')).toBe(false);
      expect(await result.current.switchContext('')).toBe(false);
    });
    expect(api.postJson).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/pod/default/web?ns=default');
  });

  it('afterSwitch (desktop Clusters menu) routes to the Cluster overview and resolves the target from config status', async () => {
    const gate = makeGate();
    const toast = makeToast();
    const onBeforeSwitch = vi.fn();
    const { result } = renderHook(() => useContexts({ gate, toast, onBeforeSwitch }));
    await act(async () => { await result.current.afterSwitch(); });
    expect(window.location.hash).toBe('#/cluster');
    expect(onBeforeSwitch).toHaveBeenCalled();
    expect(api.postJson).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Switched to beta', { title: 'Cluster' });
    expect(result.current.switchTarget).toBe('beta');
    expect(result.current.switching).toBe(false);
  });

  it('reports an unreachable cluster with an info toast', async () => {
    const gate = makeGate({ checkAuth: vi.fn(async () => false) });
    const toast = makeToast();
    api.postJson.mockResolvedValue({});
    const { result } = renderHook(() => useContexts({ gate, toast }));
    let ok;
    await act(async () => { ok = await result.current.switchContext('beta'); });
    expect(ok).toBe(false);
    expect(toast.info).toHaveBeenCalledWith('Switched to beta — cluster not reachable', { title: 'Cluster' });
    expect(window.location.hash).toBe('#/cluster');
  });

  it('a failed POST toasts an error, keeps the route and clears switching/switchTarget', async () => {
    api.postJson.mockRejectedValue(new Error('boom'));
    const gate = makeGate();
    const toast = makeToast();
    const { result } = renderHook(() => useContexts({ gate, toast }));
    let ok;
    await act(async () => { ok = await result.current.switchContext('beta'); });
    expect(ok).toBe(false);
    expect(toast.error).toHaveBeenCalledWith('boom', { title: 'Cluster' });
    expect(window.location.hash).toBe('#/pod/default/web?ns=default');
    expect(gate.fetchConfigStatus).not.toHaveBeenCalled();
    expect(result.current.switching).toBe(false);
    expect(result.current.switchTarget).toBeNull();
  });
});
