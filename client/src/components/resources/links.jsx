// Cross-link helpers shared by the resource views. Every link is a real
// `<a href="#/…">` (built with `buildHash`) so it works with the keyboard, in a
// new tab, and without JavaScript handlers; `navigateVia()` additionally calls
// the parent's `onNavigate` so the shell can keep its own state in sync.
//
// `onNavigate` may be either the new `(view, params, query)` function from
// App.jsx or the legacy `{ toNamespace, toNode, toResource, toPods }` object —
// both are supported so nothing breaks while the shell is being rewritten.
import { buildHash } from '../../hooks/useHashRoute';
import { byKey } from '../../lib/kinds';

/** Pods view filtered to one namespace. */
export const nsLink = (ns) => ({ view: 'pod', params: [], query: { ns }, legacy: (o) => o.toNamespace?.(ns) });

/** Node detail (Nodes view focused on one node). */
export const nodeLink = (name) => ({ view: 'nodes', params: [name], legacy: (o) => o.toNode?.(name) });

/** A resource in its list view (drawer opened on it). Cluster-scoped kinds omit the namespace. */
export const resourceLink = (typeKey, namespace, name) => {
  const clusterScoped = !!byKey[typeKey]?.clusterScoped;
  const ns = clusterScoped ? '' : (namespace || '');
  return {
    view: typeKey,
    params: [ns, name].filter(Boolean),
    query: ns ? { ns } : undefined,
    legacy: (o) => o.toResource?.({ type: typeKey, namespace: namespace || undefined, name }),
  };
};

/** Pods view filtered by namespace + a name prefix (workload → its pods). */
export const podsLink = (namespace, nameFilter) => ({
  view: 'pod', params: [], query: { ns: namespace, q: nameFilter },
  legacy: (o) => o.toPods?.(namespace, nameFilter),
});

export const hrefFor = (link) => buildHash(link.view, link.params, link.query);

/** Invoke `onNavigate` for a link, supporting both the function and legacy object shapes. Returns true if handled. */
export function navigateVia(onNavigate, link) {
  if (!onNavigate || !link) return false;
  if (typeof onNavigate === 'function') { onNavigate(link.view, link.params || [], link.query); return true; }
  if (typeof onNavigate === 'object' && link.legacy) { link.legacy(onNavigate); return true; }
  return false;
}

const isPlainClick = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/**
 * <XLink link={nsLink('kube-system')} onNavigate={onNavigate}>kube-system</XLink>
 * Renders an anchor with a hash href; a plain click routes through
 * `onNavigate` (when given) instead of letting the browser change the hash.
 */
export function XLink({ link, onNavigate, className = 'xlink', title, children, ...rest }) {
  if (!link) return <span className={className}>{children}</span>;
  return (
    <a
      href={hrefFor(link)}
      className={className}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        if (!isPlainClick(e)) return;
        if (navigateVia(onNavigate, link)) e.preventDefault();
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
