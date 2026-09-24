// Kubernetes-API implementations of what used to shell out to kubectl, so a
// machine without kubectl can browse and operate a cluster:
//   • REST mapping (lower-case kind / alias / `plural.group` → apiVersion,
//     plural, scope) for built-in kinds plus CRDs discovered from the cluster;
//   • the patch bodies behind rollout-restart, scale and Argo CD sync/refresh;
//   • YAML apply-document parsing/validation;
//   • a small generic request helper (server-side apply, delete, API discovery)
//     that authenticates through the KubeConfig exactly like the typed clients;
//   • per-request timeouts for the typed clients (AbortSignal via middleware);
//   • a non-interactive pod exec over the API's WebSocket.
// Pure helpers (no I/O) are exported first so they can be unit-tested.
import { Writable } from 'stream';
import * as k8s from '@kubernetes/client-node';
import yaml from 'js-yaml';
import { badRequest } from './http-errors.mjs';

export const FIELD_MANAGER = 'kubepilot';
export const RESTARTED_AT_ANNOTATION = 'kubectl.kubernetes.io/restartedAt';
export const ARGO_REFRESH_ANNOTATION = 'argocd.argoproj.io/refresh';

// ------------------------------------------------------------------
// REST mapping
// ------------------------------------------------------------------
const mapping = (apiVersion, kind, plural, namespaced = true) => {
  const [group, version] = apiVersion.includes('/') ? apiVersion.split('/') : ['', apiVersion];
  return { apiVersion, kind, plural, namespaced, group, version };
};

// Built-in kinds the UI/MCP can delete, scale, restart or apply. Order does
// not matter; lookups go by kind or plural (case-insensitive).
export const BUILTIN_MAPPINGS = Object.freeze([
  mapping('v1', 'Pod', 'pods'), mapping('v1', 'Service', 'services'), mapping('v1', 'ConfigMap', 'configmaps'),
  mapping('v1', 'Secret', 'secrets'), mapping('v1', 'ServiceAccount', 'serviceaccounts'),
  mapping('v1', 'PersistentVolumeClaim', 'persistentvolumeclaims'), mapping('v1', 'PersistentVolume', 'persistentvolumes', false),
  mapping('v1', 'Namespace', 'namespaces', false), mapping('v1', 'Node', 'nodes', false), mapping('v1', 'Endpoints', 'endpoints'),
  mapping('v1', 'Event', 'events'), mapping('v1', 'ReplicationController', 'replicationcontrollers'),
  mapping('v1', 'LimitRange', 'limitranges'), mapping('v1', 'ResourceQuota', 'resourcequotas'),
  mapping('apps/v1', 'Deployment', 'deployments'), mapping('apps/v1', 'StatefulSet', 'statefulsets'),
  mapping('apps/v1', 'DaemonSet', 'daemonsets'), mapping('apps/v1', 'ReplicaSet', 'replicasets'),
  mapping('batch/v1', 'Job', 'jobs'), mapping('batch/v1', 'CronJob', 'cronjobs'),
  mapping('networking.k8s.io/v1', 'Ingress', 'ingresses'), mapping('networking.k8s.io/v1', 'NetworkPolicy', 'networkpolicies'),
  mapping('networking.k8s.io/v1', 'IngressClass', 'ingressclasses', false),
  mapping('rbac.authorization.k8s.io/v1', 'Role', 'roles'), mapping('rbac.authorization.k8s.io/v1', 'RoleBinding', 'rolebindings'),
  mapping('rbac.authorization.k8s.io/v1', 'ClusterRole', 'clusterroles', false),
  mapping('rbac.authorization.k8s.io/v1', 'ClusterRoleBinding', 'clusterrolebindings', false),
  mapping('storage.k8s.io/v1', 'StorageClass', 'storageclasses', false),
  mapping('autoscaling/v2', 'HorizontalPodAutoscaler', 'horizontalpodautoscalers'),
  mapping('policy/v1', 'PodDisruptionBudget', 'poddisruptionbudgets'),
  mapping('discovery.k8s.io/v1', 'EndpointSlice', 'endpointslices'),
  mapping('apiextensions.k8s.io/v1', 'CustomResourceDefinition', 'customresourcedefinitions', false),
]);

// kubectl short names accepted in the :kind path segment.
const ALIASES = {
  po: 'pod', svc: 'service', cm: 'configmap', sa: 'serviceaccount', pvc: 'persistentvolumeclaim', pv: 'persistentvolume',
  ns: 'namespace', no: 'node', deploy: 'deployment', sts: 'statefulset', ds: 'daemonset', rs: 'replicaset', cj: 'cronjob',
  ing: 'ingress', netpol: 'networkpolicy', sc: 'storageclass', hpa: 'horizontalpodautoscaler', pdb: 'poddisruptionbudget',
  crd: 'customresourcedefinition', ep: 'endpoints',
};

// Canonical lower-case kind for a route segment (statefulSet → statefulset,
// deploy → deployment, deployments → deployment).
export const normalizeKind = (kind) => {
  const k = String(kind || '').toLowerCase();
  return ALIASES[k] || k;
};

// Resolve a :kind path value (lower-case kind, plural, short name, or
// `plural.group` / `kind.group` for CRDs) to a REST mapping. `crds` is the
// list produced by the CRD index ({ group, kind, plural, singular, scope,
// version }). Returns null when nothing matches.
export function restMappingFor(kind, crds = []) {
  const raw = String(kind || '').toLowerCase();
  if (!raw) return null;
  const dot = raw.indexOf('.');
  const name = normalizeKind(dot > 0 ? raw.slice(0, dot) : raw);
  const group = dot > 0 ? raw.slice(dot + 1) : null;

  const matchesName = (m) => m.kind.toLowerCase() === name || m.plural === name || (m.singular && m.singular === name);
  if (!group) {
    const builtin = BUILTIN_MAPPINGS.find(matchesName);
    if (builtin) return builtin;
  }
  for (const c of crds || []) {
    if (!c?.group || !c?.kind || !c?.plural) continue;
    if (group && c.group.toLowerCase() !== group) continue;
    if (!matchesName(c)) continue;
    const version = c.version && c.version !== '-' ? c.version : 'v1';
    return { apiVersion: `${c.group}/${version}`, kind: c.kind, plural: c.plural, namespaced: c.scope !== 'Cluster', group: c.group, version };
  }
  if (group) {
    // `deployments.apps` style for built-ins.
    const builtin = BUILTIN_MAPPINGS.find((m) => m.group.toLowerCase() === group && matchesName(m));
    if (builtin) return builtin;
  }
  return null;
}

// Human label in kubectl's style: `deployment.apps/nginx`, `pod/web-0`.
export const resourceLabel = (m, name) => `${m.kind.toLowerCase()}${m.group ? `.${m.group}` : ''}/${name}`;

// ------------------------------------------------------------------
// Patch bodies / targets (pure)
// ------------------------------------------------------------------
// `kubectl rollout restart` = strategic-merge patch of the pod template's
// restartedAt annotation, which bumps the template hash and rolls the pods.
export const restartPatch = (now = new Date()) => ({
  spec: { template: { metadata: { annotations: { [RESTARTED_AT_ANNOTATION]: now.toISOString() } } } },
});

const RESTART_METHODS = { deployment: 'patchNamespacedDeployment', statefulset: 'patchNamespacedStatefulSet', daemonset: 'patchNamespacedDaemonSet' };
export function restartTarget(kind) {
  const k = normalizeKind(kind);
  const method = RESTART_METHODS[k];
  if (!method) throw badRequest(`Kind "${kind}" cannot be rollout-restarted (Deployments, StatefulSets and DaemonSets only)`, 'not_restartable');
  return { api: 'AppsV1Api', method };
}

// `kubectl scale` targets the /scale subresource; DaemonSets have none.
const SCALE_METHODS = { deployment: 'patchNamespacedDeploymentScale', statefulset: 'patchNamespacedStatefulSetScale', replicaset: 'patchNamespacedReplicaSetScale' };
export function scaleTarget(kind) {
  const k = normalizeKind(kind);
  if (k === 'daemonset') throw badRequest('DaemonSets cannot be scaled: they run one pod per node', 'not_scalable');
  const method = SCALE_METHODS[k];
  if (!method) throw badRequest(`Kind "${kind}" cannot be scaled (Deployments, StatefulSets and ReplicaSets only)`, 'not_scalable');
  return { api: 'AppsV1Api', method };
}
export const scalePatch = (replicas) => ({ spec: { replicas: Number(replicas) } });

// Argo CD: a sync is requested by writing `.operation` (merge patch); the
// application controller picks it up. Options are already validated.
export function argoSyncPatch({ prune, dryRun, revision, applyOnly, replace, force } = {}) {
  const sync = {};
  if (prune) sync.prune = true;
  if (dryRun) sync.dryRun = true;
  if (revision != null && revision !== '') sync.revision = String(revision);
  const syncOptions = [];
  if (applyOnly) syncOptions.push('ApplyOutOfSyncOnly=true');
  if (replace) syncOptions.push('Replace=true');
  if (force) syncOptions.push('Force=true');
  if (syncOptions.length) sync.syncOptions = syncOptions;
  return { operation: { initiatedBy: { username: FIELD_MANAGER }, sync } };
}
// `kubectl annotate --overwrite app argocd.argoproj.io/refresh=hard|normal`.
export const argoRefreshPatch = (hard) => ({ metadata: { annotations: { [ARGO_REFRESH_ANNOTATION]: hard ? 'hard' : 'normal' } } });
// Drop finalizers before a non-cascading delete (orphans the managed resources).
export const dropFinalizersPatch = () => ({ metadata: { finalizers: null } });

// ------------------------------------------------------------------
// Apply documents (pure)
// ------------------------------------------------------------------
// Parse + validate an apply body: every YAML document must be a mapping
// (empty documents from trailing `---` are ignored). Returns the documents.
export function parseApplyDocuments(yamlText) {
  if (typeof yamlText !== 'string' || !yamlText.trim()) throw badRequest('Empty YAML', 'invalid_yaml');
  if (yamlText.length > 3 * 1024 * 1024) throw badRequest('YAML too large', 'invalid_yaml');
  let docs;
  try { docs = yaml.loadAll(yamlText); } catch (e) { throw badRequest(`Invalid YAML: ${e.message}`, 'invalid_yaml'); }
  docs = docs.filter((d) => d !== null && d !== undefined);
  if (!docs.length) throw badRequest('YAML contains no documents', 'invalid_yaml');
  for (const d of docs) {
    if (typeof d !== 'object' || Array.isArray(d)) throw badRequest('Every YAML document must be an object (a Kubernetes manifest)', 'invalid_yaml');
  }
  return docs;
}

// A manifest must name its apiVersion, kind and metadata.name to be applied.
export function validateApplyDocument(doc) {
  if (typeof doc?.apiVersion !== 'string' || !doc.apiVersion.trim()) throw badRequest('Manifest is missing apiVersion', 'invalid_yaml');
  if (typeof doc?.kind !== 'string' || !doc.kind.trim()) throw badRequest('Manifest is missing kind', 'invalid_yaml');
  if (typeof doc?.metadata?.name !== 'string' || !doc.metadata.name.trim()) throw badRequest('Manifest is missing metadata.name', 'invalid_yaml');
  return doc;
}

// ------------------------------------------------------------------
// Typed-client request options: per-request timeout
// ------------------------------------------------------------------
// The generated (ObjectParam) clients accept Observable-style middleware; this
// one arms an AbortSignal so a hung API server fails the request instead of
// the handler. `append` keeps the client's own User-Agent middleware.
const observable = (v) => new k8s.Observable(Promise.resolve(v));
export const requestOptions = (timeoutMs = 20000) => ({
  middleware: [{
    pre: (ctx) => { ctx.setSignal(AbortSignal.timeout(timeoutMs)); return observable(ctx); },
    post: (rsp) => observable(rsp),
  }],
  middlewareMergeStrategy: 'append',
});
// Same, plus the Content-Type the generated patch methods would otherwise get
// wrong (they default to the first advertised media type, json-patch).
export const patchOptions = (strategy, timeoutMs = 20000) => k8s.setHeaderOptions('Content-Type', strategy, requestOptions(timeoutMs));
export const { PatchStrategy } = k8s;

// Promise.race timeout for calls that do not take request options.
export const withTimeout = (promise, ms, label = 'request') => {
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${ms} ms`), { code: 'ETIMEDOUT' })), ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
};

// ------------------------------------------------------------------
// Generic API request (server-side apply, delete, discovery)
// ------------------------------------------------------------------
// Builds a request against the current cluster, lets the KubeConfig apply its
// auth (token / client cert / exec plugin) and TLS dispatcher, and sends it
// through the client's own fetch library — the same path the typed clients
// use. Non-2xx → ApiException (numeric `.code`, parsed `.body`) so
// mapUpstreamError classifies it like any other API failure.
const httpLib = new k8s.IsomorphicFetchHttpLibrary();
export async function apiRequest(kubeConfig, { method = 'GET', path, body, contentType, timeoutMs = 20000 } = {}) {
  const cluster = kubeConfig?.getCurrentCluster?.();
  if (!cluster?.server) throw new Error('No active cluster');
  const ctx = new k8s.RequestContext(String(cluster.server).replace(/\/+$/, '') + path, k8s.HttpMethod[method]);
  ctx.setHeaderParam('Accept', 'application/json');
  if (body !== undefined) {
    ctx.setHeaderParam('Content-Type', contentType || 'application/json');
    ctx.setBody(typeof body === 'string' ? body : JSON.stringify(body));
  }
  ctx.setSignal(AbortSignal.timeout(timeoutMs));
  await kubeConfig.applySecurityAuthentication(ctx);
  const resp = await httpLib.send(ctx).toPromise();
  const text = await resp.body.text();
  let data = {};
  if (text) { try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 2000) }; } }
  if (resp.httpStatusCode < 200 || resp.httpStatusCode > 299) {
    throw new k8s.ApiException(resp.httpStatusCode, data?.message || `HTTP ${resp.httpStatusCode}`, data, resp.headers || {});
  }
  return data;
}

// Discovery: `/api/v1` or `/apis/<group>/<version>` resource lists, cached per
// (scope, apiVersion) — `scope` should identify the cluster (context + server).
const DISCOVERY_TTL_MS = 5 * 60_000;
const discoveryCache = new Map(); // `${scope}|${apiVersion}` -> { at, resources }
export const clearDiscoveryCache = () => discoveryCache.clear();
export const apiVersionPath = (apiVersion) => (apiVersion.includes('/') ? `/apis/${apiVersion}` : `/api/${apiVersion}`);

export async function discoverResource(kubeConfig, apiVersion, kind, { scope = '', timeoutMs = 15000 } = {}) {
  const key = `${scope}|${apiVersion}`;
  let hit = discoveryCache.get(key);
  const find = () => (hit?.resources || []).find((r) => r.kind === kind && !String(r.name).includes('/'));
  let found = hit && Date.now() - hit.at < DISCOVERY_TTL_MS ? find() : undefined;
  if (!found) {
    let list;
    try { list = await apiRequest(kubeConfig, { path: apiVersionPath(apiVersion), timeoutMs }); }
    catch (e) {
      if (e?.code === 404) throw badRequest(`API version "${apiVersion}" is not served by this cluster`, 'unknown_api_version');
      throw e;
    }
    hit = { at: Date.now(), resources: Array.isArray(list?.resources) ? list.resources : [] };
    discoveryCache.set(key, hit);
    found = find();
  }
  if (!found) throw badRequest(`Unknown kind "${kind}" in ${apiVersion}`, 'unknown_kind');
  const [group, version] = apiVersion.includes('/') ? apiVersion.split('/') : ['', apiVersion];
  return { apiVersion, kind: found.kind, plural: found.name, namespaced: !!found.namespaced, group, version };
}

// `/apis/apps/v1/namespaces/<ns>/deployments/<name>` (+ optional subresource).
export function resourcePath(m, { namespace, name, subresource } = {}) {
  const parts = [apiVersionPath(m.apiVersion)];
  if (m.namespaced && namespace) parts.push(`namespaces/${encodeURIComponent(namespace)}`);
  parts.push(m.plural);
  if (name) parts.push(encodeURIComponent(name));
  if (subresource) parts.push(subresource);
  return parts.join('/');
}

// Server-side apply of one manifest (== `kubectl apply --server-side
// --force-conflicts --field-manager=kubepilot`). The document is sent as YAML
// with the apply-patch content type; the API server creates or updates it.
export async function serverSideApply(kubeConfig, doc, { scope = '', defaultNamespace = 'default', timeoutMs = 30000 } = {}) {
  validateApplyDocument(doc);
  const m = await discoverResource(kubeConfig, doc.apiVersion, doc.kind, { scope, timeoutMs });
  const namespace = m.namespaced ? (doc.metadata.namespace || defaultNamespace) : undefined;
  const path = `${resourcePath(m, { namespace, name: doc.metadata.name })}?fieldManager=${FIELD_MANAGER}&force=true&fieldValidation=Strict`;
  const object = await apiRequest(kubeConfig, {
    method: 'PATCH', path, body: yaml.dump(doc, { noRefs: true, lineWidth: -1 }), contentType: PatchStrategy.ServerSideApply, timeoutMs,
  });
  return { mapping: m, name: doc.metadata.name, namespace, object, message: `${resourceLabel(m, doc.metadata.name)} serverside-applied` };
}

// Apply each document in order (like `kubectl apply -f` on a multi-doc file);
// stops at the first failure. Resolves the per-document messages.
export async function applyDocuments(kubeConfig, docs, opts = {}) {
  const messages = [];
  for (const doc of docs) messages.push((await serverSideApply(kubeConfig, doc, opts)).message);
  return messages;
}

// Delete with kubectl's default cascading (background propagation).
export async function deleteResource(kubeConfig, m, { name, namespace, scope = '', timeoutMs = 30000 } = {}) {
  const full = m.plural ? m : await discoverResource(kubeConfig, m.apiVersion, m.kind, { scope, timeoutMs });
  const path = resourcePath(full, { namespace: full.namespaced ? namespace : undefined, name });
  const body = { apiVersion: 'v1', kind: 'DeleteOptions', propagationPolicy: 'Background' };
  const status = await apiRequest(kubeConfig, { method: 'DELETE', path, body, timeoutMs });
  return { status, message: `${resourceLabel(full, name)} deleted` };
}

// ------------------------------------------------------------------
// Non-interactive exec over the API (used when kubectl is absent)
// ------------------------------------------------------------------
const sink = (chunks) => new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
const exitCodeOf = (status) => {
  if (!status || status.status !== 'Failure') return 0;
  const cause = (status.details?.causes || []).find((c) => c.reason === 'ExitCode');
  const n = cause ? Number(cause.message) : NaN;
  return Number.isFinite(n) ? n : 1;
};

// Runs `sh -c <command>` in the pod and resolves { stdout, stderr, code }.
// Without a container name the pod's default container is used (the
// kubectl.kubernetes.io/default-container annotation, else the first one).
export async function execInPod(kubeConfig, { namespace, pod, container, command, timeoutMs = 30000 }) {
  let target = container;
  if (!target) {
    const p = await kubeConfig.makeApiClient(k8s.CoreV1Api).readNamespacedPod({ name: pod, namespace }, requestOptions(timeoutMs));
    target = p.metadata?.annotations?.['kubectl.kubernetes.io/default-container'] || p.spec?.containers?.[0]?.name;
  }
  const out = [], err = [];
  let code = 0, socket = null;
  const run = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => { if (!settled) { settled = true; fn(); } };
    const done = () => finish(() => resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), code }));
    new k8s.Exec(kubeConfig)
      .exec(namespace, pod, target, ['sh', '-c', command], sink(out), sink(err), null, false, (status) => { code = exitCodeOf(status); })
      .then((ws) => {
        socket = ws;
        ws.on('close', done);
        ws.on('error', (e) => finish(() => reject(e)));
      })
      .catch((e) => finish(() => reject(e)));
  });
  try { return await withTimeout(run, timeoutMs, 'exec'); }
  catch (e) { try { socket?.close(); } catch { /* ignore */ } throw e; }
}
