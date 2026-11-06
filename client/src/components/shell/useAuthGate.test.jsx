import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import useAuthGate from './useAuthGate';

vi.mock('../../lib/api', async (orig) => {
  const actual = await orig();
  return { ...actual, getJson: vi.fn(), postJson: vi.fn() };
});
import { getJson, notifyClusterAuthRequired } from '../../lib/api';

const STATUS = { loaded: true, currentContext: 'dev', contexts: ['dev'] };
const EXPIRED = { ok: false, reason: 'sso-expired', message: 'Your AWS SSO session has expired.', currentContext: 'dev' };

describe('useAuthGate: mid-session sign-in', () => {
  let auth;
  beforeEach(() => {
    vi.clearAllMocks();
    auth = { ok: true, authenticated: true, currentContext: 'dev' };
    getJson.mockImplementation(async (url) => (url === '/api/config/status' ? STATUS : auth));
  });
  const authChecks = () => getJson.mock.calls.filter(([u]) => u === '/api/config/auth').length;

  it('a request finding the sign-in over re-checks the cluster and brings the dialog up', async () => {
    const { result } = renderHook(() => useAuthGate({ enabled: true, toast: null }));
    await waitFor(() => expect(result.current.authOk).toBe(true));
    expect(authChecks()).toBe(1);
    auth = EXPIRED; // signed out meanwhile
    act(() => { notifyClusterAuthRequired(); notifyClusterAuthRequired(); notifyClusterAuthRequired(); });
    await waitFor(() => expect(result.current.showAuthError).toBe(true));
    expect(authChecks()).toBe(2); // one re-check for the burst
    expect(result.current.authState.reason).toBe('sso-expired');
  });

  it('a passing re-check keeps the app open', async () => {
    const { result } = renderHook(() => useAuthGate({ enabled: true, toast: null }));
    await waitFor(() => expect(result.current.authOk).toBe(true));
    act(() => { notifyClusterAuthRequired(); });
    await waitFor(() => expect(authChecks()).toBe(2));
    expect(result.current.showAuthError).toBe(false);
  });
});
