import { useRef } from 'react';
import useRequest from '../../hooks/useRequest';
import { getJson, errorMessage } from '../../lib/api';

const EMPTY = Object.freeze([]);

// The cluster's namespace list (real names only — no 'all' sentinel; the
// selection sentinel lives in the route, see shell/routes.js).
//
//   const { namespaces, loading, refetching, refetch } = useNamespaces({ enabled: authOk, contextKey, toast });
export default function useNamespaces({ enabled = true, contextKey = '', toast }) {
  const toastRef = useRef(toast); toastRef.current = toast;
  const { data, error, loading, refetching, refetch } = useRequest(
    ({ signal }) => getJson('/api/namespaces', { signal }).then((d) => (Array.isArray(d?.namespaces) ? d.namespaces : [])),
    {
      deps: [contextKey],
      enabled,
      dedupeKey: `namespaces:${contextKey}`,
      onError: (err) => toastRef.current?.error(errorMessage(err, 'Failed to fetch namespaces'), { title: 'Namespaces' }),
    },
  );
  return { namespaces: data || EMPTY, error, loading, refetching, refetch };
}

export { useNamespaces };
