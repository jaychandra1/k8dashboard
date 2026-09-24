// Route grammar helpers for the hash router (see hooks/useHashRoute.js).
//
//   #/cluster                                                 default / landing view (DEFAULT_VIEW)
//   #/overview?ns=a,b                                         workloads overview
//   #/<resourceKey>[/<namespace|->/<name>]?ns=a,b&q=text     resource list (+ drawer)
//   #/nodes[/<nodeName>]
//   #/events?ns=a
//   #/argocd/<dashboard|applications|view|appsets|projects|repositories|clusters>
//   #/security/<overview|images|resources|roles>
//   #/customResources/<group>/<version>/<plural>[/<namespace|->/<name>]
//   #/preferences/<section>
//   #/cluster · #/namespaces · #/topology · #/helm · #/accessControl
//
// `ns` query: comma-separated namespaces; absent → all namespaces (the
// `['all']` sentinel is what views receive as `selectedNamespaces`).
// `q`: free-text filter (owned by ResourceViewer). `-` stands for "no namespace".
import { byKey, isStandalone } from '../../lib/kinds';

export { DEFAULT_VIEW } from '../../hooks/useHashRoute';

export const ALL = 'all';
export const NONE = '-';

export const ARGO_VIEWS = ['dashboard', 'applications', 'view', 'appsets', 'projects', 'repositories', 'clusters'];
export const SECURITY_VIEWS = ['overview', 'images', 'resources', 'roles'];
export const PREF_SECTIONS = ['general', 'kubernetes', 'integrations', 'external-tools', 'assistant', 'mcp', 'about'];

/** `?ns=a,b` → ['a','b']; absent/empty → ['all']. */
export function nsFromQuery(query) {
  const raw = query?.ns;
  if (!raw) return [ALL];
  const list = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length || list.includes(ALL)) return [ALL];
  return Array.from(new Set(list));
}

/** ['a','b'] → 'a,b'; ['all'] / [] → undefined (dropped from the query). */
export function nsToQuery(list) {
  if (!Array.isArray(list) || !list.length || list.includes(ALL)) return undefined;
  return list.join(',');
}

/** Is `view` a known routable view key? */
export function isKnownView(view) {
  return !!byKey[view];
}

/** Resource views are the registry entries that go through the shared fan-out (or /api/storage). */
export function isResourceView(view) {
  const t = byKey[view];
  return !!t && !t.standalone && view !== 'overview' && view !== 'events';
}

/** `#/pod/<ns>/<name>` → { namespace, name } (namespace '' for '-'), else null. */
export function selectionFromRoute(route) {
  if (!isResourceView(route.view)) return null;
  const [ns, name] = route.params;
  if (!name) return null;
  return { namespace: ns === NONE ? '' : ns, name };
}

/** Params for a selected resource (namespace may be empty for cluster-scoped kinds). */
export function selectionToParams(res) {
  if (!res || !res.name) return [];
  return [res.namespace || NONE, res.name];
}

/** `#/customResources/<group>/<version>/<plural>[/<ns|->/<name>]` → selection object or null. */
export function crSelectionFromRoute(route) {
  if (route.view !== 'customResources') return null;
  const [group, version, plural, ns, name] = route.params;
  if (!group || !version || !plural) return null;
  const base = { group, version, plural, crdName: `${plural}.${group}` };
  if (name) return { level: 'instance', ...base, namespace: ns && ns !== NONE ? ns : undefined, name };
  return { level: 'kind', ...base };
}

export function crSelectionToParams(sel) {
  if (!sel || !sel.group || !sel.version || !sel.plural) return [];
  if (sel.level === 'instance' && sel.name) return [sel.group, sel.version, sel.plural, sel.namespace || NONE, sel.name];
  return [sel.group, sel.version, sel.plural];
}

/** The target view for "go to namespace" cross-links: keep list views, otherwise Pods. */
export function namespaceTargetView(view) {
  return (!byKey[view] || isStandalone(view) || view === 'overview') ? 'pod' : view;
}
