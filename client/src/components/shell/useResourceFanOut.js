import { useEffect, useMemo, useRef } from 'react';
import useRequest from '../../hooks/useRequest';
import { getJson, p, errorMessage, isAbortError, ApiError } from '../../lib/api';
import { byKey, isClusterScoped, isStandalone } from '../../lib/kinds';
import { ALL } from './routes';

const EMPTY_OBJ = Object.freeze({});
const EMPTY = Object.freeze([]);
const CONCURRENCY = 12;

// Which fetch a view needs:
//   'namespaced' → GET /api/resources/:ns for each selected (or every) namespace
//   'storage'    → one GET /api/storage (PersistentVolumes, StorageClasses)
//   'none'       → the view loads its own data (standalone / events / preferences)
// Note: /api/resources/:ns returns every namespaced kind in one call (there is
// no per-kind endpoint), so the current kind and the Overview share one fetch.
export function fanOutMode(view) {
  const t = byKey[view];
  if (!t || isStandalone(view) || view === 'events') return 'none';
  return isClusterScoped(view) ? 'storage' : 'namespaced';
}

/**
 * The shared "all namespaces" fan-out with useRequest-style cancellation: a
 * new run id (abort) on context switch AND on namespace/type change, a bounded
 * concurrency pool, per-namespace RBAC failures tolerated, and `partial` /
 * `errors` from the backend surfaced as `partialErrors`.
 *
 *   const { allResources, partialErrors, loading, refetching, error, refetch, active } =
 *     useResourceFanOut({ enabled: authOk, contextKey, view, selectedNamespaces, allNamespaces });
 */
export default function useResourceFanOut({ enabled = true, contextKey = '', view, selectedNamespaces = [ALL], allNamespaces = EMPTY }) {
  const mode = enabled ? fanOutMode(view) : 'none';
  const targets = useMemo(() => {
    if (mode !== 'namespaced') return EMPTY;
    const explicit = selectedNamespaces.filter((n) => n && n !== ALL);
    return explicit.length ? explicit : allNamespaces;
  }, [mode, selectedNamespaces, allNamespaces]);
  const targetsKey = targets.join(',');
  const targetsRef = useRef(targets); targetsRef.current = targets;
  const modeRef = useRef(mode); modeRef.current = mode;

  const req = useRequest(async ({ signal }) => {
    if (modeRef.current === 'storage') {
      const data = await getJson('/api/storage', { signal });
      const items = {};
      const errors = [];
      Object.entries(data || {}).forEach(([k, v]) => { if (Array.isArray(v) && k !== 'errors') items[k] = v; });
      if (data?.partial && Array.isArray(data.errors)) errors.push(...data.errors);
      return { items, errors };
    }
    const list = targetsRef.current;
    const merged = {};
    const errors = [];
    let cursor = 0;
    let failedNamespaces = 0;
    const worker = async () => {
      while (cursor < list.length) {
        if (signal.aborted) return;
        const ns = list[cursor++];
        try {
          const data = await getJson(p('api', 'resources', ns), { signal });
          if (signal.aborted) return;
          Object.entries(data || {}).forEach(([k, v]) => {
            if (!Array.isArray(v) || k === 'errors') return;
            if (!merged[k]) merged[k] = [];
            merged[k].push(...v);
          });
          if (data?.partial && Array.isArray(data.errors)) {
            data.errors.forEach((e) => errors.push({ kind: e.kind, error: e.error, namespace: ns }));
          }
        } catch (err) {
          if (isAbortError(err)) throw err;
          // Skip a namespace that fails (e.g. RBAC) rather than failing all.
          failedNamespaces += 1;
          errors.push({ kind: '*', namespace: ns, error: errorMessage(err) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
    if (signal.aborted) throw new ApiError({ code: 'aborted', message: 'Request aborted' });
    if (list.length && failedNamespaces === list.length) {
      throw new ApiError({ status: 0, code: 'fanout_failed', message: errors[0]?.error || 'Failed to fetch resources' });
    }
    return { items: merged, errors };
  }, {
    deps: [contextKey, mode, targetsKey],
    enabled: mode === 'storage' || (mode === 'namespaced' && targets.length > 0),
    dedupeKey: `fanout:${contextKey}:${mode}:${targetsKey}`,
  });

  // Switching kinds within the same namespaces reuses the (all-kinds) payload
  // but refreshes it in the background so the new list is not stale.
  const hasData = !!req.data;
  const { refetch } = req;
  const prevView = useRef(view);
  useEffect(() => {
    if (prevView.current === view) return;
    prevView.current = view;
    if (hasData && fanOutMode(view) !== 'none') refetch();
  }, [view, hasData, refetch]);

  return {
    allResources: req.data?.items || EMPTY_OBJ,
    partialErrors: req.data?.errors || EMPTY,
    loading: req.loading,
    refetching: req.refetching,
    error: req.error,
    updatedAt: req.updatedAt,
    refetch,
    active: mode !== 'none',
  };
}

export { useResourceFanOut };
