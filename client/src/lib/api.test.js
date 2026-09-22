import { describe, it, expect, beforeEach, vi } from 'vitest';
import { p, withQuery, wsUrl, setToken, getToken, clearToken, bootstrapTokenFromHash, ApiError, api, onUnauthorized, resetUnauthorized, getJson, sseFetch, errorMessage } from './api';

beforeEach(() => { clearToken(); sessionStorage.clear(); resetUnauthorized(); });

describe('token storage', () => {
  it('stores in sessionStorage and memory', () => {
    setToken(' abc ');
    expect(getToken()).toBe('abc');
    expect(sessionStorage.getItem('k8dashboard.token')).toBe('abc');
    clearToken();
    expect(getToken()).toBeNull();
  });
  it('reads a legacy k8sight.token and migrates it on the next write', () => {
    sessionStorage.setItem('k8sight.token', 'old-tok');
    expect(getToken()).toBe('old-tok');
    setToken('new-tok');
    expect(sessionStorage.getItem('k8dashboard.token')).toBe('new-tok');
    expect(sessionStorage.getItem('k8sight.token')).toBeNull();
  });
  it('bootstraps from #token= and scrubs the hash', () => {
    window.location.hash = '#token=xyz';
    expect(bootstrapTokenFromHash()).toBe(true);
    expect(getToken()).toBe('xyz');
    expect(window.location.hash).toBe('');
  });
  it('bootstraps from a route hash with a token query', () => {
    window.location.hash = '#/pods?ns=a&token=t2';
    expect(bootstrapTokenFromHash()).toBe(true);
    expect(getToken()).toBe('t2');
    expect(window.location.hash).toBe('#/pods?ns=a');
    window.location.hash = '';
  });
  it('returns false when absent', () => {
    window.location.hash = '#/pods';
    expect(bootstrapTokenFromHash()).toBe(false);
    window.location.hash = '';
  });
});

describe('url helpers', () => {
  it('p encodes each segment', () => {
    expect(p('api', 'resources', 'kube-system')).toBe('/api/resources/kube-system');
    expect(p('api', 'pods', 'a/b', 'c d')).toBe('/api/pods/a%2Fb/c%20d');
    expect(p('api', null, 'x', '')).toBe('/api/x');
  });
  it('withQuery skips empties', () => {
    expect(withQuery('/a', { x: 1, y: '', z: undefined, w: 'q r' })).toBe('/a?x=1&w=q%20r');
    expect(withQuery('/a?b=1', { c: 2 })).toBe('/a?b=1&c=2');
  });
  it('wsUrl builds ws:// from location and adds the token', () => {
    setToken('tok');
    const u = wsUrl('/ws/exec', { namespace: 'ns', pod: 'p' });
    expect(u.startsWith('ws://')).toBe(true);
    expect(u).toContain('/ws/exec?namespace=ns&pod=p&token=tok');
  });
});

describe('axios instance', () => {
  it('adds Authorization + X-Requested-With headers', async () => {
    setToken('t1');
    const spy = vi.spyOn(api, 'request').mockImplementation(async (cfg) => ({ data: { ok: true }, config: cfg }));
    // run the request interceptor manually
    const handlers = api.interceptors.request.handlers.map((h) => h.fulfilled);
    let cfg = { url: '/api/x', headers: {} };
    for (const h of handlers) cfg = await h(cfg);
    expect(cfg.headers.Authorization).toBe('Bearer t1');
    expect(cfg.headers['X-Requested-With']).toBe('k8dashboard');
    spy.mockRestore();
  });
  it('normalises errors to ApiError and fires onUnauthorized once', async () => {
    const cb = vi.fn();
    const off = onUnauthorized(cb);
    const rejected = api.interceptors.response.handlers[0].rejected;
    const err = { response: { status: 401, data: { error: 'Unauthorized', code: 'auth_required' } }, config: { url: '/api/x' } };
    await expect(rejected(err)).rejects.toMatchObject({ status: 401, code: 'auth_required', message: 'Unauthorized' });
    await expect(rejected(err)).rejects.toBeInstanceOf(ApiError);
    expect(cb).toHaveBeenCalledTimes(1);
    off();
  });
  it('getJson returns data', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValue({ data: { a: 1 } });
    expect(await getJson('/api/a')).toEqual({ a: 1 });
    spy.mockRestore();
  });
});

describe('sseFetch', () => {
  it('adds headers and throws ApiError on non-2xx', async () => {
    setToken('sse');
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 421, clone() { return this; }, json: async () => ({ error: 'Host not allowed' }) });
    vi.stubGlobal('fetch', fetchMock);
    await expect(sseFetch('/api/assistant', { q: 1 })).rejects.toMatchObject({ status: 421, message: 'Host not allowed' });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer sse');
    expect(init.headers['X-Requested-With']).toBe('k8dashboard');
    expect(init.method).toBe('POST');
    vi.unstubAllGlobals();
  });
});

describe('errorMessage', () => {
  it('reads from ApiError, axios errors and plain errors', () => {
    expect(errorMessage(new ApiError({ message: 'nope' }))).toBe('nope');
    expect(errorMessage({ response: { data: { error: 'boom' } } })).toBe('boom');
    expect(errorMessage(new Error('x'))).toBe('x');
    expect(errorMessage(null, 'fb')).toBe('fb');
  });
});
