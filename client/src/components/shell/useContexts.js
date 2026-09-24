import { useCallback, useRef } from 'react';
import { postJson, errorMessage } from '../../lib/api';

// Context switching (pinned rail, selector, palette, auth-error modal).
// Extracted from App.jsx.
//
//   const { switchContext } = useContexts({ gate, toast, onBeforeSwitch });
export default function useContexts({ gate, toast, onBeforeSwitch }) {
  const { configStatus, fetchConfigStatus, checkAuth } = gate;
  const toastRef = useRef(toast); toastRef.current = toast;
  const beforeRef = useRef(onBeforeSwitch); beforeRef.current = onBeforeSwitch;
  const current = configStatus.currentContext;

  const switchContext = useCallback(async (ctx) => {
    if (!ctx || ctx === current) return false;
    try {
      await postJson('/api/config/context', { contextName: ctx });
    } catch (err) {
      toastRef.current?.error(errorMessage(err, `Failed to switch to ${ctx}`), { title: 'Cluster' });
      return false;
    }
    // Reset the view for the new cluster (route → overview, selection cleared),
    // then reload config + re-check auth. Namespaces/resources re-fetch on their
    // own because they are keyed on the current context.
    beforeRef.current?.(ctx);
    await fetchConfigStatus();
    const ok = await checkAuth();
    if (ok) toastRef.current?.success(`Switched to ${ctx}`, { title: 'Cluster' });
    else toastRef.current?.info(`Switched to ${ctx} — cluster not reachable`, { title: 'Cluster' });
    return ok;
  }, [current, fetchConfigStatus, checkAuth]);

  return { switchContext };
}

export { useContexts };
