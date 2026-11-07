import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { _resetHistoryIndex } from '../../hooks/useHashRoute';

const api = vi.hoisted(() => ({ postJson: vi.fn() }));
vi.mock('../../lib/api', async (orig) => {
  const real = await orig();
  return { ...real, postJson: api.postJson };
});

import useContexts, { POST_SWITCH_VIEW, HOME_VIEW, CONNECT_STEPS } from './useContexts';

const makeGate = (over = {}) => ({
  configStatus: { currentContext: 'alpha', contexts: ['alpha', 'beta'] },
  fetchConfigStatus: vi.fn(async () => ({ currentContext: 'beta' })),
  checkAuth: vi.fn(async () => true),
  resetAuth: vi.fn(),
  ...over,
});
const makeToast = () => ({ success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() });
const disconnects = () => api.postJson.mock.calls.filter(([u]) => u === '/api/config/disconnect').length;

describe('useContexts: connecting', () => {
  beforeEach(() => {
    _resetHistoryIndex();
    window.location.hash = '#/home';
    api.postJson.mockReset();
    api.postJson.mockResolvedValue({});
  });

  it('connect(another) selects it, signs in, then lands on the Dashboard — step by step', async () => {
    let release;
    api.postJson.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const gate = makeGate();
    const toast = makeToast();
    const { result } = renderHook(() => useContexts({ gate, toast }));
    expect([POST_SWITCH_VIEW, HOME_VIEW, CONNECT_STEPS.map((s) => s.key)]).toEqual(['cluster', 'home', ['select', 'auth', 'dashboard']]);

    let done;
    act(() => { done = result.current.connect('beta'); });
    expect(result.current).toMatchObject({ switching: true, switchTarget: 'beta', step: 'select' });
    expect(api.postJson).toHaveBeenCalledWith('/api/config/context', { contextName: 'beta' });
    expect(window.location.hash).toBe('#/home'); // still selecting

    await act(async () => { release({}); await done; });
    expect(window.location.hash).toBe('#/cluster');
    expect(gate.checkAuth).toHaveBeenCalledWith(expect.objectContaining({ isCurrent: expect.any(Function) }));
    expect(toast.success).toHaveBeenCalledWith('Connected to beta', { title: 'Cluster' });
    await waitFor(() => expect(result.current.switching).toBe(false));
  });

  it('connect(the selected cluster) signs in without selecting it again (Home → Connect)', async () => {
    const gate = makeGate({ fetchConfigStatus: vi.fn(async () => ({ currentContext: 'alpha' })) });
    const { result } = renderHook(() => useContexts({ gate, toast: makeToast() }));
    let ok;
    await act(async () => { ok = await result.current.connect('alpha'); });
    expect(ok).toBe(true);
    expect(api.postJson).not.toHaveBeenCalledWith('/api/config/context', expect.anything());
    expect(gate.checkAuth).toHaveBeenCalledTimes(1);
  });

  it('switchContext is a no-op for the current cluster or an empty name', async () => {
    const { result } = renderHook(() => useContexts({ gate: makeGate(), toast: makeToast() }));
    await act(async () => {
      expect(await result.current.switchContext('alpha')).toBe(false);
      expect(await result.current.switchContext('')).toBe(false);
    });
    expect(api.postJson).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/home');
  });

  it('afterSwitch (desktop Clusters menu) signs in to what the menu selected', async () => {
    const gate = makeGate();
    const toast = makeToast();
    const onBeforeSwitch = vi.fn();
    const { result } = renderHook(() => useContexts({ gate, toast, onBeforeSwitch }));
    await act(async () => { await result.current.afterSwitch(); });
    expect(window.location.hash).toBe('#/cluster');
    expect(onBeforeSwitch).toHaveBeenCalled();
    expect(api.postJson).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Connected to beta', { title: 'Cluster' });
    expect(result.current.switchTarget).toBe('beta');
  });

  it('a failed sign-in returns false (the sign-in dialog takes over) with no success toast', async () => {
    const gate = makeGate({ checkAuth: vi.fn(async () => false) });
    const toast = makeToast();
    const { result } = renderHook(() => useContexts({ gate, toast }));
    let ok;
    await act(async () => { ok = await result.current.connect('beta'); });
    expect(ok).toBe(false);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('a failed selection toasts an error and stays put', async () => {
    api.postJson.mockRejectedValueOnce(new Error('boom'));
    const gate = makeGate();
    const toast = makeToast();
    const { result } = renderHook(() => useContexts({ gate, toast }));
    let ok;
    await act(async () => { ok = await result.current.connect('beta'); });
    expect(ok).toBe(false);
    expect(toast.error).toHaveBeenCalledWith('boom', { title: 'Cluster' });
    expect(window.location.hash).toBe('#/home');
    expect(gate.checkAuth).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ switching: false, switchTarget: null, step: null });
  });

  it('Cancel while signing in: back to Home, the late answer is dropped, the server lets go', async () => {
    let answer;
    const gate = makeGate({
      checkAuth: vi.fn(({ isCurrent }) => new Promise((r) => { answer = () => r(isCurrent() ? true : null); })),
    });
    const toast = makeToast();
    const { result } = renderHook(() => useContexts({ gate, toast }));
    let done;
    await act(async () => { done = result.current.connect('beta'); await Promise.resolve(); await Promise.resolve(); });
    await waitFor(() => expect(result.current.step).toBe('auth'));
    act(() => { result.current.cancel(); });
    expect(window.location.hash).toBe('#/home');
    expect(gate.resetAuth).toHaveBeenCalled();
    expect(result.current).toMatchObject({ switching: false, step: null });
    await act(async () => { answer(); expect(await done).toBe(false); });
    expect(toast.success).not.toHaveBeenCalled();
    expect(disconnects()).toBeGreaterThanOrEqual(1);
  });

  it('disconnect: the server forgets the connection and Home opens', async () => {
    window.location.hash = '#/cluster';
    const gate = makeGate();
    const { result } = renderHook(() => useContexts({ gate, toast: makeToast() }));
    act(() => { result.current.disconnect(); });
    expect(window.location.hash).toBe('#/home');
    expect(gate.resetAuth).toHaveBeenCalled();
    expect(disconnects()).toBe(1);
  });
});
