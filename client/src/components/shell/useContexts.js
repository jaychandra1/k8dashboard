import { useCallback, useRef } from 'react';
import { postJson, errorMessage } from '../../lib/api';

// Context switching (top-bar switcher, sidebar selector, palette, auth-error
// modal, desktop "Clusters" menu). Extracted from App.jsx.
//
//   const { switchContext, afterSwitch } = useContexts({ gate, toast, onBeforeSwitch });
//
// `switchContext(ctx)` POSTs the switch then runs `afterSwitch`. `afterSwitch`
// alone is the post-switch path (route → overview, reload config status,
// re-check auth, toast) for switches made elsewhere — the desktop app's native
// menu talks to the backend directly and then tells the renderer via a
// `kubepilot:host` `context-changed` event.
export default function useContexts({ gate, toast, onBeforeSwitch }) {
  const { configStatus, fetchConfigStatus, checkAuth } = gate;
  const toastRef = useRef(toast); toastRef.current = toast;
  const beforeRef = useRef(onBeforeSwitch); beforeRef.current = onBeforeSwitch;
  const current = configStatus.currentContext;

  const afterSwitch = useCallback(async (ctx) => {
    // Reset the view for the new cluster (route → overview, selection cleared),
    // then reload config + re-check auth. Namespaces/resources re-fetch on their
    // own because they are keyed on the current context.
    beforeRef.current?.(ctx);
    const status = await fetchConfigStatus();
    const name = ctx || status?.currentContext || 'cluster';
    const ok = await checkAuth();
    if (ok) toastRef.current?.success(`Switched to ${name}`, { title: 'Cluster' });
    else toastRef.current?.info(`Switched to ${name} — cluster not reachable`, { title: 'Cluster' });
    return ok;
  }, [fetchConfigStatus, checkAuth]);

  const switchContext = useCallback(async (ctx) => {
    if (!ctx || ctx === current) return false;
    try {
      await postJson('/api/config/context', { contextName: ctx });
    } catch (err) {
      toastRef.current?.error(errorMessage(err, `Failed to switch to ${ctx}`), { title: 'Cluster' });
      return false;
    }
    return afterSwitch(ctx);
  }, [current, afterSwitch]);

  return { switchContext, afterSwitch };
}

export { useContexts };
