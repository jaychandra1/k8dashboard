// Data-fetching hook that replaces the `axios.get + useEffect + live flag`
// pattern in every view.
//
//   const { data, error, loading, refetching, refetch, setData } = useRequest(
//     ({ signal }) => getJson(p('api', 'resources', ns), { signal }),
//     { deps: [ns], pollMs: 15000, dedupeKey: `resources:${ns}` },
//   );
//
// - one AbortController per run; cancelled on deps change / unmount
// - stale responses are ignored (run id)
// - polling pauses while document.hidden and resumes with an immediate refetch
// - exponential backoff on error (x2 per failure, capped at 5x pollMs)
// - keepPreviousData keeps `data` while `refetching` (no flash of empty state)
// - identical in-flight requests with the same dedupeKey share one promise
import { useCallback, useEffect, useRef, useState } from 'react';
import useVisibility from './useVisibility';
import { isAbortError } from '../lib/api';

const inflight = new Map(); // dedupeKey → { promise, controller, count }

/** Test/diagnostic hook: number of shared in-flight requests. */
export const _inflightSize = () => inflight.size;

function runShared(key, fn, controller) {
  if (key && inflight.has(key)) {
    const entry = inflight.get(key);
    entry.count += 1;
    return { promise: entry.promise, shared: true };
  }
  // Start synchronously so the AbortController is wired before any await.
  let promise;
  try { promise = Promise.resolve(fn({ signal: controller.signal })); } catch (e) { promise = Promise.reject(e); }
  if (key) {
    const entry = { promise, controller, count: 1 };
    inflight.set(key, entry);
    // The derived promise from .finally() would otherwise surface a rejection
    // nobody awaits (the caller awaits the original `promise`).
    promise.finally(() => { if (inflight.get(key) === entry) inflight.delete(key); }).catch(() => {});
  }
  return { promise, shared: false };
}

export default function useRequest(fn, {
  deps = [],
  enabled = true,
  pollMs = 0,
  keepPreviousData = true,
  dedupeKey,
  onSuccess,
  onError,
  initialData,
} = {}) {
  const [state, setState] = useState(() => ({
    data: initialData, error: null, loading: enabled, refetching: false, updatedAt: 0,
  }));
  const visible = useVisibility();
  const fnRef = useRef(fn); fnRef.current = fn;
  const cbRef = useRef({ onSuccess, onError }); cbRef.current = { onSuccess, onError };
  const runId = useRef(0);
  const controllerRef = useRef(null);
  const timerRef = useRef(null);
  const failures = useRef(0);
  const hasDataRef = useRef(initialData !== undefined);
  const mounted = useRef(true);
  const enabledRef = useRef(enabled); enabledRef.current = enabled;
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const pollRef = useRef(pollMs); pollRef.current = pollMs;
  const keyRef = useRef(dedupeKey); keyRef.current = dedupeKey;

  const runRef = useRef(null);

  const clearTimer = () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; } };

  const schedule = useCallback((delay) => {
    clearTimer();
    if (!pollRef.current || !enabledRef.current || !mounted.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (visibleRef.current) runRef.current?.(true);
    }, delay);
  }, []);

  const run = useCallback(async () => {
    if (!enabledRef.current || !mounted.current) return undefined;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const id = ++runId.current;
    const background = hasDataRef.current && keepPreviousData;
    setState((s) => ({
      ...s,
      loading: !background,
      refetching: background,
      data: keepPreviousData ? s.data : undefined,
      error: background ? s.error : null,
    }));
    const { promise, shared } = runShared(keyRef.current, fnRef.current, controller);
    try {
      const data = await promise;
      if (id !== runId.current || !mounted.current) return data;
      failures.current = 0;
      hasDataRef.current = true;
      setState({ data, error: null, loading: false, refetching: false, updatedAt: Date.now() });
      cbRef.current.onSuccess?.(data);
      schedule(pollRef.current);
      return data;
    } catch (err) {
      if (id !== runId.current || !mounted.current) return undefined;
      if (isAbortError(err) && !shared) return undefined;
      failures.current += 1;
      setState((s) => ({ ...s, error: err, loading: false, refetching: false }));
      cbRef.current.onError?.(err);
      if (pollRef.current) {
        const backoff = Math.min(pollRef.current * 2 ** failures.current, pollRef.current * 5);
        schedule(backoff);
      }
      return undefined;
    }
  }, [keepPreviousData, schedule]);
  runRef.current = run;

  // (Re)run on deps / enabled change.
  useEffect(() => {
    mounted.current = true;
    failures.current = 0;
    if (!enabled) {
      controllerRef.current?.abort();
      clearTimer();
      setState((s) => ({ ...s, loading: false, refetching: false }));
      return undefined;
    }
    run(false);
    return () => {
      controllerRef.current?.abort();
      clearTimer();
      runId.current += 1; // invalidate any in-flight result
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);

  // Unmount.
  useEffect(() => () => { mounted.current = false; controllerRef.current?.abort(); clearTimer(); }, []);

  // Polling pause / resume with the tab's visibility.
  useEffect(() => {
    if (!pollMs || !enabled) { clearTimer(); return undefined; }
    if (!visible) { clearTimer(); return undefined; }
    // Became visible again: if the data is stale (older than the poll cadence) refetch now.
    if (hasDataRef.current && Date.now() - (state.updatedAt || 0) >= pollMs) run(true);
    else if (!timerRef.current) schedule(pollMs);
    return undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, pollMs, enabled]);

  const refetch = useCallback(() => run(true), [run]);
  const setData = useCallback((updater) => {
    hasDataRef.current = true;
    setState((s) => ({ ...s, data: typeof updater === 'function' ? updater(s.data) : updater }));
  }, []);

  return { data: state.data, error: state.error, loading: state.loading, refetching: state.refetching, updatedAt: state.updatedAt, refetch, setData };
}

export { useRequest };

/**
 * Imperative variant for effects that need the freshest `fn` without
 * re-subscribing: returns a stable `(args) => Promise` with its own aborter.
 */
export function useRequestRef(fn) {
  const ref = useRef(fn); ref.current = fn;
  const controller = useRef(null);
  useEffect(() => () => controller.current?.abort(), []);
  return useCallback((...args) => {
    controller.current?.abort();
    controller.current = new AbortController();
    return ref.current({ signal: controller.current.signal }, ...args);
  }, []);
}
