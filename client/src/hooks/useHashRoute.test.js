import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useHashRoute, { parseHash, buildHash, _resetHistoryIndex } from './useHashRoute';

describe('parseHash / buildHash', () => {
  it('parses view, params and query', () => {
    expect(parseHash('#/pod/kube-system/coredns-1?tab=logs&q=a%20b')).toEqual({ view: 'pod', params: ['kube-system', 'coredns-1'], query: { tab: 'logs', q: 'a b' } });
    expect(parseHash('')).toEqual({ view: 'cluster', params: [], query: {} });
    expect(parseHash('#')).toEqual({ view: 'cluster', params: [], query: {} });
    expect(parseHash('#/argocd')).toEqual({ view: 'argocd', params: [], query: {} });
    expect(parseHash('#/x?flag')).toEqual({ view: 'x', params: [], query: { flag: '' } });
  });
  it('builds and round-trips', () => {
    expect(buildHash('pod', ['ns', 'na/me'], { tab: 'logs', empty: '' })).toBe('#/pod/ns/na%2Fme?tab=logs');
    expect(buildHash()).toBe('#/cluster');
    const r = parseHash(buildHash('svc', ['a b'], { q: 'x&y' }));
    expect(r).toEqual({ view: 'svc', params: ['a b'], query: { q: 'x&y' } });
  });
});

describe('useHashRoute', () => {
  beforeEach(() => { _resetHistoryIndex(); window.location.hash = ''; });

  it('navigates and tracks back/forward', async () => {
    const { result } = renderHook(() => useHashRoute());
    expect(result.current.route.view).toBe('cluster');
    expect(result.current.canBack).toBe(false);
    act(() => result.current.navigate('pod', ['kube-system'], { tab: 'logs' }));
    expect(window.location.hash).toBe('#/pod/kube-system?tab=logs');
    expect(result.current.route).toEqual({ view: 'pod', params: ['kube-system'], query: { tab: 'logs' } });
    expect(result.current.canBack).toBe(true);
    expect(result.current.canForward).toBe(false);
    act(() => result.current.navigate('nodes'));
    expect(result.current.route.view).toBe('nodes');
    // simulate the browser back button
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(result.current.route.view).toBe('pod');
    expect(result.current.canForward).toBe(true);
  });

  it('replace does not add a history entry', () => {
    const { result } = renderHook(() => useHashRoute());
    act(() => result.current.navigate('pod'));
    act(() => result.current.navigate('pod', ['ns'], {}, { replace: true }));
    expect(window.location.hash).toBe('#/pod/ns');
    expect(result.current.canBack).toBe(true);
    act(() => result.current.setQuery({ tab: 'yaml' }));
    expect(window.location.hash).toBe('#/pod/ns?tab=yaml');
  });

  it('reacts to external hashchange', async () => {
    const { result } = renderHook(() => useHashRoute());
    await act(async () => {
      window.location.hash = '#/helm';
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(result.current.route.view).toBe('helm');
  });
});
