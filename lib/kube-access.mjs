// Working in a cluster you were given part of.
//
// Many people get a Role in one namespace and nothing cluster-wide (QA may
// read pods and restart deployments in "qaenv", and that is all). The API then
// answers 403 to everything else, including "list namespaces", and no API
// tells a user which namespaces they do have. So:
//
//   * a 403 is a normal answer, said in plain words, and never with the
//     identity the API puts in it (on EKS that is the role's ARN, with the
//     account ID and often an e-mail address);
//   * the namespaces such a user works in are the ones they name, once
//     (checked against the cluster and remembered per cluster), plus the one
//     their kubeconfig context names.

// ---------------------------------------------------------------------------
// What the API said
// ---------------------------------------------------------------------------
/**
 * The API's Status object behind an error. The Kubernetes client hands it over
 * as text for most failures ("Unknown API Status Code!", body a JSON string).
 */
export function kubeStatus(err) {
  const body = err?.body;
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  if (typeof body !== 'string') return null;
  const text = body.trim();
  if (!text.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

const httpStatus = (err) => {
  for (const c of [err?.code, err?.statusCode, err?.status, err?.response?.statusCode, kubeStatus(err)?.code])
    if (typeof c === 'number' && c >= 100 && c <= 599) return c;
  return undefined;
};

/** Did the cluster refuse this because the user isn't allowed (not because the sign-in failed)? */
export const isForbidden = (err) =>
  httpStatus(err) === 403 || (httpStatus(err) === undefined && typeof err?.stderr === 'string' && /\(Forbidden\)/.test(err.stderr));

// `pods is forbidden: User "…" cannot list resource "pods" in API group "" in the namespace "qaenv"`
const DENIED = /cannot (\w+) resource "([^"]+)"(?: in API group "([^"]*)")?(?: in the namespace "([^"]+)")?/;
/** { verb, resource, group, namespace } of a refusal, or null when the API didn't say. */
export function deniedAction(err) {
  const said = kubeStatus(err)?.message ?? (typeof err?.stderr === 'string' ? err.stderr : typeof err?.body === 'string' ? '' : err?.message);
  const m = DENIED.exec(String(said || ''));
  return m ? { verb: m[1], resource: m[2], group: m[3] || '', namespace: m[4] || '' } : null;
}

const ACTION = { get: 'view', list: 'list', watch: 'watch', create: 'create', update: 'change', patch: 'change', delete: 'delete', deletecollection: 'delete' };
// Sub-resources read better as what the user was doing.
const SPECIAL = {
  'pods/log': 'read pod logs',
  'pods/exec': 'open a terminal in pods',
  'pods/attach': 'attach to pods',
  'pods/portforward': 'forward ports of pods',
  'pods/eviction': 'evict pods',
};
/**
 * "You don't have permission to list pods in namespace qaenv." Built from the
 * action only: the API's own sentence names the user, which is never shown.
 */
export function forbiddenMessage(denied) {
  if (!denied) return "You don't have permission to do this on this cluster.";
  const where = denied.namespace ? ` in namespace ${denied.namespace}` : '';
  const [resource, sub] = denied.resource.split('/');
  let what = SPECIAL[denied.resource];
  if (!what && sub === 'scale') what = `scale ${resource}`;
  if (!what) what = `${ACTION[denied.verb] || denied.verb} ${sub ? `${resource} (${sub})` : resource}`;
  return `You don't have permission to ${what}${where}.`;
}

// ---------------------------------------------------------------------------
// What a user may do in one namespace (SelfSubjectRulesReview)
// ---------------------------------------------------------------------------
// What every signed-in user has (asking about themselves): not access to the namespace.
const SELF = new Set(['authorization.k8s.io', 'authentication.k8s.io']);
/**
 * From a SelfSubjectRulesReview's status: { any, incomplete, list }.
 *   any        — a rule gives the user something in the namespace
 *   incomplete — the cluster could not see every rule (a webhook authoriser):
 *                "nothing found" is then not proof of no access
 *   list       — the resources they may list ("pods", "deployments.apps", "*")
 */
export function namespaceAccess(status) {
  const rules = (status?.resourceRules || []).filter((r) => !(r.apiGroups || []).every((g) => SELF.has(g)));
  const list = new Set();
  for (const r of rules) {
    if (!(r.verbs || []).some((v) => v === 'list' || v === '*')) continue;
    for (const group of r.apiGroups || [])
      for (const resource of r.resources || []) {
        if (resource.includes('/')) continue;
        list.add(resource === '*' || group === '*' ? '*' : group ? `${resource}.${group}` : resource);
      }
  }
  return { any: rules.length > 0, incomplete: !!status?.incomplete, list: [...list].sort() };
}

// ---------------------------------------------------------------------------
// The namespaces a user named, per cluster (settings.json → knownNamespaces)
// ---------------------------------------------------------------------------
// Kept as a list of { context, namespaces } entries, not as an object keyed by
// the context: a context's name comes from the kubeconfig (and, when switching
// cluster, from a request), so it is compared as a value and never used as a
// property name.
const LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
export const isNamespaceName = (s) => typeof s === 'string' && LABEL.test(s);
export const MAX_KNOWN_NAMESPACES = 50;

const tidy = (names) => [...new Set(names.filter(isNamespaceName))].sort().slice(0, MAX_KNOWN_NAMESPACES);
/** The setting as stored, with anything that isn't an entry dropped; one entry per context, in name order. */
const entriesOf = (settings) => {
  const seen = new Set();
  const out = [];
  for (const e of Array.isArray(settings?.knownNamespaces) ? settings.knownNamespaces : []) {
    if (!e || typeof e.context !== 'string' || !e.context || !Array.isArray(e.namespaces) || seen.has(e.context)) continue;
    seen.add(e.context);
    const namespaces = tidy(e.namespaces);
    if (namespaces.length) out.push({ context: e.context, namespaces });
  }
  return out.sort((a, b) => (a.context < b.context ? -1 : a.context > b.context ? 1 : 0));
};
const savedFor = (settings, context) => entriesOf(settings).find((e) => e.context === context)?.namespaces || [];

/**
 * The namespaces to offer a user who may not list them: the ones they added
 * for this cluster and the one its kubeconfig context names. Sorted, unique.
 */
export function knownNamespaces(settings, context, contextNamespace) {
  const names = new Set(savedFor(settings, context));
  if (isNamespaceName(contextNamespace)) names.add(contextNamespace);
  return [...names].sort();
}

/** The `knownNamespaces` setting with `name` added for `context` (or unchanged). */
export function withKnownNamespace(settings, context, name) {
  const all = entriesOf(settings);
  if (typeof context !== 'string' || !context || !isNamespaceName(name)) return all;
  const namespaces = tidy([...savedFor(settings, context), name]);
  return entriesOf({ knownNamespaces: [...all.filter((e) => e.context !== context), { context, namespaces }] });
}

/** …with `name` removed for `context`; a cluster left with none is dropped. `name` omitted: the whole cluster. */
export function withoutKnownNamespace(settings, context, name) {
  const others = entriesOf(settings).filter((e) => e.context !== context);
  const left = name === undefined ? [] : savedFor(settings, context).filter((n) => n !== name);
  return left.length ? entriesOf({ knownNamespaces: [...others, { context, namespaces: left }] }) : others;
}
