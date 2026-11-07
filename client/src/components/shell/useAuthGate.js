import { useCallback, useEffect, useRef, useState } from 'react';
import { getJson, postJson, errorMessage, onClusterAuthRequired } from '../../lib/api';

// Kubeconfig status and cluster sign-in. Startup reads the kubeconfig only
// (the Home page lists its clusters); the auth check — the first call to a
// cluster — runs when the user connects (useContexts.connect), then
// auto-recovery → (AuthErrorModal | app). Extracted from App.jsx. While the
// app runs, a request answered `cluster_auth_required` (the open cluster's
// sign-in is missing or over) re-runs the check, which brings the dialog up.
//
//   const gate = useAuthGate({ enabled: hasToken, session, toast });
//   gate.authOk / gate.showConfigModal / gate.showAuthError / gate.checkingAuth …

const SERVER_DOWN = 'Cannot reach the backend server on port 3001. Is it running?';

export default function useAuthGate({ enabled = true, session = 0, toast }) {
  const [configStatus, setConfigStatus] = useState({ loaded: false, contexts: [] });
  const [configChecked, setConfigChecked] = useState(false);
  const [serverUnreachable, setServerUnreachable] = useState(false);
  // { checked, ok, reason, message, currentContext, server }
  const [authState, setAuthState] = useState({ checked: false, ok: false });
  const [authRetrying, setAuthRetrying] = useState(false);
  const [autoRecovering, setAutoRecovering] = useState(false);
  const [forceConfigModal, setForceConfigModal] = useState(false);
  const autoRecoverRef = useRef(null); // context we've already auto-retried (one attempt each)
  const toastRef = useRef(toast); toastRef.current = toast;

  const fetchConfigStatus = useCallback(async () => {
    try {
      const data = await getJson('/api/config/status');
      setConfigStatus(data);
      setServerUnreachable(false);
      return data;
    } catch {
      setServerUnreachable(true);
      setConfigStatus({ loaded: false, contexts: [] });
      return null;
    } finally {
      setConfigChecked(true);
    }
  }, []);

  // Verify the selected cluster can authenticate + is reachable (this is the
  // connection). `isCurrent()` false when the answer arrives (the user
  // cancelled): the answer is dropped and null returned.
  const checkAuth = useCallback(async ({ isCurrent } = {}) => {
    try {
      const data = await getJson('/api/config/auth');
      if (isCurrent && !isCurrent()) return null;
      setAuthState({ ...data, checked: true });
      if (!data.ok && data.limited) toastRef.current?.info(data.message, { title: 'Limited access' });
      return !!data.ok;
    } catch (err) {
      if (isCurrent && !isCurrent()) return null;
      setAuthState({ checked: true, ok: false, reason: 'error', message: err?.status ? errorMessage(err) : 'Failed to reach the backend server on port 3001.' });
      return false;
    }
  }, []);

  // Not connected (Disconnect, Cancel, Back to clusters): the Home page.
  const resetAuth = useCallback(() => setAuthState({ checked: false, ok: false }), []);

  const retryAuth = useCallback(async () => {
    setAuthRetrying(true);
    try {
      if (serverUnreachable) await fetchConfigStatus();
      // Reload the kubeconfig first so a fresh cloud login (in-app sign-in, or an
      // external `az login` / `aws sso login`) is actually picked up — the backend
      // caches exec-credential tokens on the loaded kubeconfig otherwise.
      try { await postJson('/api/config/reload'); } catch { /* non-fatal — fall back to a plain re-check */ }
      return await checkAuth();
    } finally {
      setAuthRetrying(false);
    }
  }, [serverUnreachable, fetchConfigStatus, checkAuth]);

  // Boot / re-boot (after a new token) — fetch the kubeconfig status.
  useEffect(() => {
    if (!enabled) return;
    setAuthState({ checked: false, ok: false });
    fetchConfigStatus();
  }, [enabled, session, fetchConfigStatus]);

  // Mid-session: the open cluster needs a sign-in (signed out, session over).
  // One re-check at a time and at most every few seconds: it runs the
  // credential helper once; on failure the AuthErrorModal replaces the app.
  const authOkNow = useRef(false); authOkNow.current = !!authState.ok;
  const recheck = useRef({ running: false, at: 0 });
  useEffect(() => {
    if (!enabled) return undefined;
    return onClusterAuthRequired(() => {
      const r = recheck.current;
      if (!authOkNow.current || r.running || Date.now() - r.at < 4000) return;
      r.running = true;
      r.at = Date.now();
      Promise.resolve(checkAuth()).finally(() => { r.running = false; });
    });
  }, [enabled, checkAuth]);

  // Auto-recover: if the selected context's auth is expired but the credential
  // looks refreshable, silently reload + re-check once before showing the error
  // modal. One attempt per context avoids a retry loop.
  const authOk = !!authState.ok;
  useEffect(() => {
    if (authOk) { autoRecoverRef.current = null; return; }
    if (forceConfigModal || serverUnreachable) return;
    if (!authState.checked || authRetrying || autoRecovering) return;
    const recoverable = authState.reason === 'unauthorized' || authState.reason === 'error';
    const ctx = authState.currentContext || configStatus.currentContext;
    if (recoverable && ctx && autoRecoverRef.current !== ctx) {
      autoRecoverRef.current = ctx;
      setAutoRecovering(true);
      Promise.resolve(retryAuth()).finally(() => setAutoRecovering(false));
    }
  }, [authState, authOk, authRetrying, autoRecovering, forceConfigModal, serverUnreachable, configStatus.currentContext, retryAuth]);

  // Load a kubeconfig from a user-provided path; resolves to null on success or
  // the ApiError (with `code` / `field`) for the modal to render inline.
  const loadConfigFromPath = useCallback(async (filePath) => {
    try {
      await postJson('/api/config/load', { filePath });
      setForceConfigModal(false);
      setAuthState({ checked: false, ok: false }); // re-gate on the new config
      await fetchConfigStatus();
      return null;
    } catch (err) {
      return err;
    }
  }, [fetchConfigStatus]);

  // The kubeconfig dialog only on request (Home → Add cluster → Kubeconfig
  // file, or its "no clusters" state): without a kubeconfig, Home says so.
  const showConfigModal = configChecked && !serverUnreachable && forceConfigModal;
  const checkingAuth = configStatus.loaded && !forceConfigModal && autoRecovering;
  const showAuthError = configStatus.loaded && !forceConfigModal && authState.checked && !authState.ok && !autoRecovering;
  const serverError = serverUnreachable && configChecked ? { reason: 'error', message: SERVER_DOWN } : null;

  return {
    configStatus, configChecked, serverUnreachable, serverError,
    authState, authOk, authRetrying, autoRecovering,
    forceConfigModal, setForceConfigModal,
    fetchConfigStatus, checkAuth, resetAuth, retryAuth, loadConfigFromPath,
    showConfigModal, checkingAuth, showAuthError,
  };
}

export { useAuthGate };
