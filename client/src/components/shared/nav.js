// Bridge between the two `onNavigate` shapes views may receive:
//   - the legacy object from App.jsx: { toNamespace(ns), toResource({type, namespace, name}), toPods(ns, filter) }
//   - the route-based function from the new App shell: onNavigate(view, params?, query?)
// Views call these helpers instead of poking at the prop directly.
import { kindType } from '../../lib/kinds';

export function navToResource(onNavigate, { type, kind, namespace, name }) {
  if (!onNavigate) return false;
  const view = type || kindType(kind);
  if (typeof onNavigate === 'function') { onNavigate(view, [namespace, name].filter(Boolean)); return true; }
  if (typeof onNavigate.toResource === 'function') { onNavigate.toResource({ type: view, namespace, name }); return true; }
  return false;
}

export function navToNamespace(onNavigate, namespace) {
  if (!onNavigate || !namespace) return false;
  if (typeof onNavigate === 'function') { onNavigate('namespaces', [namespace]); return true; }
  if (typeof onNavigate.toNamespace === 'function') { onNavigate.toNamespace(namespace); return true; }
  return false;
}

export function navToPods(onNavigate, namespace, nameFilter) {
  if (!onNavigate) return false;
  if (typeof onNavigate === 'function') { onNavigate('pod', [namespace].filter(Boolean), nameFilter ? { q: nameFilter } : undefined); return true; }
  if (typeof onNavigate.toPods === 'function') { onNavigate.toPods(namespace, nameFilter); return true; }
  return false;
}

export function navToView(onNavigate, view, params) {
  if (!onNavigate) return false;
  if (typeof onNavigate === 'function') { onNavigate(view, params); return true; }
  return false;
}
