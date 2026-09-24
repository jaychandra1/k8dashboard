import { useCallback, useRef, useState } from 'react';
import { postJson, errorMessage } from '../../lib/api';
import { navigateTo } from '../../hooks/useHashRoute';

// Context switching (top-bar switcher + context picker, palette, auth-error
// modal, desktop "Clusters" menu). Extracted from App.jsx.
//
//   const { switchContext, afterSwitch, switching, switchTarget } = useContexts({ gate, toast, onBeforeSwitch? });
//
// `switchContext(ctx)` POSTs the switch then runs `afterSwitch`. `afterSwitch`
// alone is the post-switch path (route → Cluster overview, reload config
// status, re-check auth, toast) for switches made elsewhere — the desktop
// app's native menu talks to the backend directly and then tells the renderer
// via a `kubepilot:host` `context-changed` event.
//
// `switching` is true from the moment a switch starts (before the POST) until
// config status + auth have been re-checked for the new context; App uses it
// to drive the branded LoadingScreen over the main region. `switchTarget` is
// the context being switched to (null after a failed switch).
export const POST_SWITCH_VIEW = 'cluster';

export default function useContexts({ gate, toast, onBeforeSwitch }) {
  const { configStatus, fetchConfigStatus, checkAuth } = gate;
  const toastRef = useRef(toast); toastRef.current = toast;
  const beforeRef = useRef(onBeforeSwitch); beforeRef.current = onBeforeSwitch;
  const current = configStatus.currentContext;
  const [switching, setSwitching] = useState(false);
  const [switchTarget, setSwitchTarget] = useState(null);

  const afterSwitch = useCallback(async (ctx) => {
    setSwitching(true);
    setSwitchTarget(ctx || null);
    try {
      // Land on the Cluster overview for the new cluster (selection and
      // namespace filter cleared), then reload config + re-check auth.
      // Namespaces/resources re-fetch on their own because they are keyed on
      // the current context.
      navigateTo(POST_SWITCH_VIEW, [], {});
      beforeRef.current?.(ctx);
      const status = await fetchConfigStatus();
      const name = ctx || status?.currentContext || 'cluster';
      if (!ctx && status?.currentContext) setSwitchTarget(status.currentContext);
      const ok = await checkAuth();
      if (ok) toastRef.current?.success(`Switched to ${name}`, { title: 'Cluster' });
      else toastRef.current?.info(`Switched to ${name} — cluster not reachable`, { title: 'Cluster' });
      return ok;
    } finally {
      setSwitching(false);
    }
  }, [fetchConfigStatus, checkAuth]);

  const switchContext = useCallback(async (ctx) => {
    if (!ctx || ctx === current) return false;
    setSwitching(true);
    setSwitchTarget(ctx);
    try {
      await postJson('/api/config/context', { contextName: ctx });
    } catch (err) {
      setSwitching(false);
      setSwitchTarget(null);
      toastRef.current?.error(errorMessage(err, `Failed to switch to ${ctx}`), { title: 'Cluster' });
      return false;
    }
    return afterSwitch(ctx);
  }, [current, afterSwitch]);

  return { switchContext, afterSwitch, switching, switchTarget };
}

export { useContexts };
