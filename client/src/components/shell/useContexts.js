import { useCallback, useRef, useState } from 'react';
import { postJson, errorMessage } from '../../lib/api';
import { navigateTo } from '../../hooks/useHashRoute';

// Connecting to a cluster. Nothing connects at startup: the app opens on the
// Home page, and a connection starts only when the user picks a cluster
// (Home, cluster switcher, context picker, palette, auth-error dialog, the
// desktop "Clusters" menu). Extracted from App.jsx.
//
//   const { connect, switchContext, afterSwitch, cancel, disconnect, switching, switchTarget, step } = useContexts({ gate, toast });
//
// connect(ctx): select ctx (POST /api/config/context, when it isn't the
//   selected one) → sign in (GET /api/config/auth: the kubeconfig's
//   credentials, the first call to the cluster) → the Dashboard, whose summary
//   loads behind the loading screen; resource lists load as their views open.
// switchContext(ctx): connect to another cluster (no-op for the current one).
// afterSwitch(ctx): the same once ctx is already selected (the desktop menu
//   selects it itself and then tells the renderer).
// cancel() / disconnect(): stop — the server forgets the connection — and go
//   back to Home. A late answer from a cancelled sign-in is dropped.
// `switching`: a connection is under way; `step`: its current CONNECT_STEPS key.
export const POST_SWITCH_VIEW = 'cluster';
export const HOME_VIEW = 'home';
export const CONNECT_STEPS = Object.freeze([
  { key: 'select', label: 'Reading the kubeconfig entry' },
  { key: 'auth', label: 'Signing in to the cluster' },
  { key: 'dashboard', label: 'Loading the cluster summary' },
]);

export default function useContexts({ gate, toast, onBeforeSwitch }) {
  const { configStatus, fetchConfigStatus, checkAuth, resetAuth } = gate;
  const toastRef = useRef(toast); toastRef.current = toast;
  const beforeRef = useRef(onBeforeSwitch); beforeRef.current = onBeforeSwitch;
  const current = configStatus.currentContext;
  const [switching, setSwitching] = useState(false);
  const [switchTarget, setSwitchTarget] = useState(null);
  const [step, setStep] = useState(null);
  const runRef = useRef(0); // the connection in progress; bumped by cancel/disconnect

  const afterSwitch = useCallback(async (ctx, run = ++runRef.current) => {
    const live = () => run === runRef.current;
    setSwitching(true);
    setSwitchTarget(ctx || null);
    setStep('auth');
    try {
      // The Dashboard is where a connection lands (selection and namespace
      // filter cleared); it shows once the sign-in passes.
      navigateTo(POST_SWITCH_VIEW, [], {});
      beforeRef.current?.(ctx);
      const status = await fetchConfigStatus();
      if (!live()) return false;
      const name = ctx || status?.currentContext || 'cluster';
      if (!ctx && status?.currentContext) setSwitchTarget(status.currentContext);
      const ok = await checkAuth({ isCurrent: live });
      if (!live()) {
        // Cancelled while signing in: if it got through anyway, let go again.
        if (ok) postJson('/api/config/disconnect').catch(() => {});
        return false;
      }
      if (ok) {
        setStep('dashboard');
        toastRef.current?.success(`Connected to ${name}`, { title: 'Cluster' });
      }
      return !!ok;
    } finally {
      if (live()) {
        setSwitching(false);
        setStep(null);
      }
    }
  }, [fetchConfigStatus, checkAuth]);

  const connect = useCallback(async (ctx) => {
    const target = ctx || current;
    if (!target) return false;
    const run = ++runRef.current;
    setSwitching(true);
    setSwitchTarget(target);
    setStep('select');
    if (target !== current) {
      try {
        await postJson('/api/config/context', { contextName: target });
      } catch (err) {
        if (run !== runRef.current) return false;
        setSwitching(false);
        setSwitchTarget(null);
        setStep(null);
        toastRef.current?.error(errorMessage(err, `Failed to switch to ${target}`), { title: 'Cluster' });
        return false;
      }
      if (run !== runRef.current) return false;
    }
    return afterSwitch(target, run);
  }, [current, afterSwitch]);

  const switchContext = useCallback(
    (ctx) => (ctx && ctx !== current ? connect(ctx) : Promise.resolve(false)),
    [current, connect],
  );

  // Back to Home: stop a connection under way, or end the current one.
  const leave = useCallback(() => {
    runRef.current += 1;
    setSwitching(false);
    setSwitchTarget(null);
    setStep(null);
    resetAuth?.();
    postJson('/api/config/disconnect').catch(() => {});
    navigateTo(HOME_VIEW, [], {});
  }, [resetAuth]);

  return { connect, switchContext, afterSwitch, cancel: leave, disconnect: leave, switching, switchTarget, step };
}

export { useContexts };
