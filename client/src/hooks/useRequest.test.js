import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import useRequest, { _inflightSize } from './useRequest';

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('useRequest', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  it('loads data and exposes loading/refetching', async () => {
    const fn = vi.fn().mockResolvedValue({ n: 1 });
    const { result } = renderHook(() => useRequest(fn));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
    expect(result.current.loading).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps previous data while refetching', async () => {
    let n = 0;
    const fn = vi.fn(() => Promise.resolve({ n: ++n }));
    const { result } = renderHook(() => useRequest(fn));
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
    let pr;
    act(() => { pr = result.current.refetch(); });
    expect(result.current.data).toEqual({ n: 1 });
    expect(result.current.refetching).toBe(true);
    await act(async () => { await pr; });
    expect(result.current.data).toEqual({ n: 2 });
    expect(result.current.refetching).toBe(false);
  });

  it('aborts the previous run when deps change and ignores stale responses', async () => {
    const resolvers = [];
    const fn = vi.fn(({ signal }) => new Promise((resolve) => { resolvers.push({ resolve, signal }); }));
    const { result, rerender } = renderHook(({ id }) => useRequest(fn, { deps: [id] }), { initialProps: { id: 1 } });
    expect(fn).toHaveBeenCalledTimes(1);
    rerender({ id: 2 });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(resolvers[0].signal.aborted).toBe(true);
    await act(async () => { resolvers[0].resolve('stale'); await Promise.resolve(); });
    expect(result.current.data).toBeUndefined();
    await act(async () => { resolvers[1].resolve('fresh'); await Promise.resolve(); });
    await waitFor(() => expect(result.current.data).toBe('fresh'));
  });

  it('polls, and backs off exponentially on error (capped at 5x)', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    renderHook(() => useRequest(fn, { pollMs: 1000 }));
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(fn).toHaveBeenCalledTimes(2);
    fn.mockRejectedValue(new Error('down'));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(fn).toHaveBeenCalledTimes(3); // failure #1 → next in 2000
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(fn).toHaveBeenCalledTimes(4); // failure #2 → next in 4000
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(fn).toHaveBeenCalledTimes(5); // failure #3 → 8000 capped to 5000
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fn).toHaveBeenCalledTimes(6);
  });

  it('pauses polling while hidden and refetches immediately when visible again', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    renderHook(() => useRequest(fn, { pollMs: 1000 }));
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fn).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await flush();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('dedupes identical in-flight requests by key', async () => {
    let resolve;
    const fn = vi.fn(() => new Promise((r) => { resolve = r; }));
    const a = renderHook(() => useRequest(fn, { dedupeKey: 'same' }));
    const b = renderHook(() => useRequest(fn, { dedupeKey: 'same' }));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(_inflightSize()).toBe(1);
    await act(async () => { resolve('shared'); await Promise.resolve(); });
    await waitFor(() => expect(a.result.current.data).toBe('shared'));
    await waitFor(() => expect(b.result.current.data).toBe('shared'));
    expect(_inflightSize()).toBe(0);
  });

  it('does nothing when disabled and aborts on unmount', async () => {
    const fn = vi.fn(() => new Promise(() => {}));
    const { result, unmount, rerender } = renderHook(({ on }) => useRequest(fn, { enabled: on }), { initialProps: { on: false } });
    expect(fn).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    rerender({ on: true });
    expect(fn).toHaveBeenCalledTimes(1);
    const { signal } = fn.mock.calls[0][0];
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it('setData updates locally', async () => {
    const fn = vi.fn().mockResolvedValue([1]);
    const { result } = renderHook(() => useRequest(fn));
    await waitFor(() => expect(result.current.data).toEqual([1]));
    act(() => result.current.setData((d) => [...d, 2]));
    expect(result.current.data).toEqual([1, 2]);
  });
});
