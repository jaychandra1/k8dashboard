import { useCallback, useRef } from 'react';
import useRequest from '../../hooks/useRequest';
import { getJson, putJson, errorMessage } from '../../lib/api';

// Pinned clusters, persisted server-side (`/api/settings/pins`) so the in-app
// cluster switcher and the desktop app's native "Clusters" menu share one list.
//
//   const { pins, togglePin, isPinned } = usePins({ enabled, toast });
//
// The pre-2.1 rail kept pins in localStorage['pinnedClusters']; the first load
// merges that list into the server's and removes the key (one-time migration).

export const LEGACY_PINS_KEY = 'pinnedClusters';
export const MAX_PINS = 50;

const uniq = (list) => [...new Set(list.filter((s) => typeof s === 'string' && s))].slice(0, MAX_PINS);

// null → no legacy key; [] → key present but unusable (still worth clearing).
export function readLegacyPins() {
  try {
    const raw = localStorage.getItem(LEGACY_PINS_KEY);
    if (raw == null) return null;
    const v = JSON.parse(raw);
    return Array.isArray(v) ? uniq(v) : [];
  } catch {
    return [];
  }
}

export function clearLegacyPins() {
  try { localStorage.removeItem(LEGACY_PINS_KEY); } catch { /* ignore */ }
}

// Fetch the server list, migrating legacy localStorage pins on the way.
export async function loadPins({ signal } = {}) {
  const data = await getJson('/api/settings/pins', { signal });
  const server = Array.isArray(data?.pins) ? uniq(data.pins) : [];
  const legacy = readLegacyPins();
  if (legacy === null) return server;
  const merged = uniq([...server, ...legacy]);
  if (merged.length === server.length) { clearLegacyPins(); return server; }
  const saved = await putJson('/api/settings/pins', { pins: merged }, { signal });
  clearLegacyPins(); // only once the server has them
  return Array.isArray(saved?.pins) ? saved.pins : merged;
}

export default function usePins({ enabled = true, toast } = {}) {
  const toastRef = useRef(toast); toastRef.current = toast;
  const { data, setData, refetch, loading } = useRequest(loadPins, {
    deps: [], enabled, dedupeKey: 'settings:pins', initialData: [],
  });
  const pins = Array.isArray(data) ? data : [];
  const pinsRef = useRef(pins); pinsRef.current = pins;

  // Optimistic write; rolls back and toasts on failure.
  const setPins = useCallback(async (next) => {
    const prev = pinsRef.current;
    const clean = uniq(next);
    setData(clean);
    try {
      const saved = await putJson('/api/settings/pins', { pins: clean });
      if (Array.isArray(saved?.pins)) setData(saved.pins);
      return true;
    } catch (err) {
      setData(prev);
      toastRef.current?.error(errorMessage(err, 'Could not save pinned clusters'), { title: 'Cluster' });
      return false;
    }
  }, [setData]);

  const togglePin = useCallback((ctx) => {
    if (!ctx) return Promise.resolve(false);
    const cur = pinsRef.current;
    return setPins(cur.includes(ctx) ? cur.filter((p) => p !== ctx) : [...cur, ctx]);
  }, [setPins]);

  const isPinned = useCallback((ctx) => pinsRef.current.includes(ctx), []);

  return { pins, togglePin, isPinned, setPins, refetch, loading };
}

export { usePins };
