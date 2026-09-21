import useRequest from '../../hooks/useRequest';
import { getJson, p } from '../../lib/api';

/**
 * Full detail for one Application. Callers mount the consuming component with
 * `key={namespace/name}` so a change of app remounts it — a slow response for
 * the previous app can never land in the new one's state (useRequest also
 * aborts and ignores stale runs). Polls every 20 s while the tab is visible.
 */
export default function useAppDetail(app, refreshSignal = 0) {
  const ns = app?.namespace; const name = app?.name;
  return useRequest(
    ({ signal }) => getJson(p('api', 'argocd', 'application', ns, name), { signal }),
    { deps: [ns, name, refreshSignal], enabled: !!(ns && name), pollMs: 20000, dedupeKey: app ? `argocd:app:${ns}/${name}` : undefined },
  );
}

export { useAppDetail };
