import { useCallback, useEffect, useRef, useState } from 'react';
import { getJson, postJson, errorMessage } from '../../lib/api';

// Startup gate: kubeconfig status → cluster auth pre-check → auto-recovery →
// (KubeConfigModal | AuthErrorModal | app). Extracted from App.jsx.
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

  // Verify the loaded kubeconfig can authenticate + reach the cluster.
  const checkAuth = useCallback(async () => {
    try {
      const data = await getJson('/api/config/auth');
      setAuthState({ ...data, checked: true });
      if (!data.ok && data.limited) toastRef.current?.info(data.message, { title: 'Limited access' });
      return !!data.ok;
    } catch (err) {
      setAuthState({ checked: true, ok: false, reason: 'error', message: err?.status ? errorMessage(err) : 'Failed to reach the backend server on port 3001.' });
      return false;
    }
  }, []);

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

  // Once a kubeconfig is parsed, verify the credentials actually work before
  // loading the app (unless the user asked to switch configs).
  useEffect(() => {
    if (enabled && configStatus.loaded && !forceConfigModal) checkAuth();
  }, [enabled, configStatus.loaded, forceConfigModal, checkAuth]);

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

  const showConfigModal = configChecked && !serverUnreachable && (!configStatus.loaded || forceConfigModal);
  const checkingAuth = configStatus.loaded && !forceConfigModal && (!authState.checked || autoRecovering);
  const showAuthError = configStatus.loaded && !forceConfigModal && authState.checked && !authState.ok && !autoRecovering;
  const serverError = serverUnreachable && configChecked ? { reason: 'error', message: SERVER_DOWN } : null;

  return {
    configStatus, configChecked, serverUnreachable, serverError,
    authState, authOk, authRetrying, autoRecovering,
    forceConfigModal, setForceConfigModal,
    fetchConfigStatus, checkAuth, retryAuth, loadConfigFromPath,
    showConfigModal, checkingAuth, showAuthError,
  };
}

export { useAuthGate };
