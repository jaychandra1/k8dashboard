import { useCallback, useRef } from 'react';
import useRequest from '../../hooks/useRequest';
import { getJson, postJson, del, p, errorMessage } from '../../lib/api';

const EMPTY = Object.freeze([]);
const read = (d) => ({ list: Array.isArray(d?.namespaces) ? d.namespaces : [], restricted: d?.restricted === true });

// The cluster's namespace list (real names only — no 'all' sentinel; the
// selection sentinel lives in the route, see shell/routes.js).
//
// `restricted`: the signed-in user may not list namespaces (a Role in one or
// two of them, nothing cluster-wide). The list is then the namespaces they
// added by name, which `add` / `remove` change (see shell/NamespaceAccess.jsx).
//
//   const { namespaces, restricted, add, remove, loading, refetching, refetch } =
//     useNamespaces({ enabled: authOk, contextKey, toast });
export default function useNamespaces({ enabled = true, contextKey = '', toast }) {
  const toastRef = useRef(toast); toastRef.current = toast;
  const { data, error, loading, refetching, refetch, setData } = useRequest(
    ({ signal }) => getJson('/api/namespaces', { signal }).then(read),
    {
      deps: [contextKey],
      enabled,
      dedupeKey: `namespaces:${contextKey}`,
      onError: (err) => toastRef.current?.error(errorMessage(err, 'Failed to fetch namespaces'), { title: 'Namespaces' }),
    },
  );
  // The server answers with the new list: shown at once, no second request.
  const add = useCallback(async (name) => {
    const d = await postJson('/api/namespaces/known', { name });
    setData({ list: Array.isArray(d?.namespaces) ? d.namespaces : [], restricted: true });
    return d;
  }, [setData]);
  const remove = useCallback(async (name) => {
    const d = await del(p('api', 'namespaces', 'known', name));
    setData({ list: Array.isArray(d?.namespaces) ? d.namespaces : [], restricted: true });
    return d;
  }, [setData]);

  return { namespaces: data?.list || EMPTY, restricted: !!data?.restricted, add, remove, error, loading, refetching, refetch };
}

export { useNamespaces };
