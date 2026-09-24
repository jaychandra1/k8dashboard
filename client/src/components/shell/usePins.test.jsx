import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ getJson: vi.fn(), putJson: vi.fn() }));
vi.mock('../../lib/api', async (orig) => {
  const real = await orig();
  return { ...real, getJson: api.getJson, putJson: api.putJson };
});

import usePins, { LEGACY_PINS_KEY, loadPins } from './usePins';

describe('usePins', () => {
  beforeEach(() => {
    localStorage.clear();
    api.getJson.mockReset();
    api.putJson.mockReset();
    api.putJson.mockImplementation(async (_url, body) => ({ pins: body.pins }));
  });

  it('loads pins from the server and exposes isPinned', async () => {
    api.getJson.mockResolvedValue({ pins: ['a', 'b'] });
    const { result } = renderHook(() => usePins());
    await waitFor(() => expect(result.current.pins).toEqual(['a', 'b']));
    expect(api.getJson).toHaveBeenCalledWith('/api/settings/pins', expect.anything());
    expect(result.current.isPinned('a')).toBe(true);
    expect(result.current.isPinned('zzz')).toBe(false);
    expect(api.putJson).not.toHaveBeenCalled();
  });

  it('migrates legacy localStorage pins once: PUT the merged list, then remove the key', async () => {
    localStorage.setItem(LEGACY_PINS_KEY, JSON.stringify(['b', 'c', 'b', 42]));
    api.getJson.mockResolvedValue({ pins: ['a'] });
    const { result } = renderHook(() => usePins());
    await waitFor(() => expect(result.current.pins).toEqual(['a', 'b', 'c']));
    expect(api.putJson).toHaveBeenCalledTimes(1);
    expect(api.putJson).toHaveBeenCalledWith('/api/settings/pins', { pins: ['a', 'b', 'c'] }, expect.anything());
    expect(localStorage.getItem(LEGACY_PINS_KEY)).toBeNull();

    // Nothing left to migrate on the next load.
    api.putJson.mockClear();
    expect(await loadPins()).toEqual(['a']);
    expect(api.putJson).not.toHaveBeenCalled();
  });

  it('drops a legacy key that adds nothing without a PUT; keeps it if the PUT fails', async () => {
    localStorage.setItem(LEGACY_PINS_KEY, JSON.stringify(['a']));
    api.getJson.mockResolvedValue({ pins: ['a'] });
    expect(await loadPins()).toEqual(['a']);
    expect(api.putJson).not.toHaveBeenCalled();
    expect(localStorage.getItem(LEGACY_PINS_KEY)).toBeNull();

    localStorage.setItem(LEGACY_PINS_KEY, JSON.stringify(['b']));
    api.putJson.mockRejectedValueOnce(new Error('offline'));
    await expect(loadPins()).rejects.toThrow('offline');
    expect(localStorage.getItem(LEGACY_PINS_KEY)).toBe(JSON.stringify(['b']));
  });

  it('togglePin adds/removes optimistically and persists; rolls back and toasts on failure', async () => {
    api.getJson.mockResolvedValue({ pins: ['a'] });
    const toast = { error: vi.fn() };
    const { result } = renderHook(() => usePins({ toast }));
    await waitFor(() => expect(result.current.pins).toEqual(['a']));

    await act(async () => { await result.current.togglePin('b'); });
    expect(result.current.pins).toEqual(['a', 'b']);
    expect(api.putJson).toHaveBeenLastCalledWith('/api/settings/pins', { pins: ['a', 'b'] });

    await act(async () => { await result.current.togglePin('a'); });
    expect(result.current.pins).toEqual(['b']);

    api.putJson.mockRejectedValueOnce(new Error('nope'));
    await act(async () => { await result.current.togglePin('c'); });
    expect(result.current.pins).toEqual(['b']);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
