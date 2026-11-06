// Removing a cluster (a kubeconfig context) from the kubeconfig file that
// defines it — like `kubectl config delete-context`, plus `delete-user` and
// `delete-cluster` for the entries no remaining context still uses. Pure: the
// caller reads the file, backs it up and writes the result.
import { load, dump } from './yaml.mjs';

/** A kubeconfig file's text as a plain document. Throws when it isn't one. */
export function parseKubeconfigDoc(text) {
  const doc = load(text) ?? {};
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new Error('not a kubeconfig');
  for (const key of ['clusters', 'users', 'contexts']) {
    if (doc[key] != null && !Array.isArray(doc[key])) throw new Error(`kubeconfig "${key}" is not a list`);
  }
  return doc;
}

export const definesContext = (doc, name) => (doc?.contexts || []).some((c) => c?.name === name);

export const dumpKubeconfigDoc = (doc) => dump(doc, { noRefs: true, lineWidth: -1 });

/**
 * Remove context `name` from `doc` (not changed; a new document is returned).
 *   inUse:       { users: Set, clusters: Set } — entries referenced by the
 *                contexts that stay, in any kubeconfig file loaded with this one.
 *   nextCurrent: the context to make current when `name` was this file's
 *                current context (else its first remaining context).
 * → { doc, context, user: { name, removed } | null, cluster: { name, removed } | null, wasCurrent }
 */
export function removeContextFromDoc(doc, name, { inUse = {}, nextCurrent = null } = {}) {
  const contextsBefore = doc.contexts || [];
  const entry = contextsBefore.find((c) => c?.name === name);
  if (!entry) throw new Error(`context "${name}" is not in this file`);
  const contexts = contextsBefore.filter((c) => c?.name !== name);
  const stillUsed = (key, set, value) => !!set?.has?.(value) || contexts.some((c) => c?.context?.[key] === value);
  const plan = (key, listKey, set) => {
    const value = entry.context?.[key];
    if (!value) return null;
    const defined = (doc[listKey] || []).some((x) => x?.name === value);
    return { name: value, removed: defined && !stillUsed(key, set, value) };
  };
  const user = plan('user', 'users', inUse.users);
  const cluster = plan('cluster', 'clusters', inUse.clusters);

  const next = { ...doc, contexts };
  if (user?.removed) next.users = (doc.users || []).filter((u) => u?.name !== user.name);
  if (cluster?.removed) next.clusters = (doc.clusters || []).filter((c) => c?.name !== cluster.name);
  const wasCurrent = doc['current-context'] === name;
  if (wasCurrent) {
    const target = contexts.some((c) => c?.name === nextCurrent) ? nextCurrent : contexts[0]?.name;
    next['current-context'] = target || '';
  }
  return { doc: next, context: name, user, cluster, wasCurrent };
}
