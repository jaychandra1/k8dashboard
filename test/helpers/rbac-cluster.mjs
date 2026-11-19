// A stand-in Kubernetes API that enforces RBAC the way a real one does, for a
// user who was given a Role in one namespace and nothing cluster-wide — the
// common "QA can see its own namespace" setup:
//
//   Role (namespace qaenv): secrets, configmaps  get list watch create update patch delete
//                           pods                 get list watch      pods/log  get
//                           deployments.apps     get list watch patch
//                           replicasets.apps     get list watch
//
// Everything else answers 403 Forbidden, as the API server does: listing
// namespaces, nodes, anything in another namespace, any other kind in qaenv.
// Discovery and the self-subject reviews are open to every signed-in user
// (system:discovery, system:basic-user).
import http from 'node:http';

export const QA_NAMESPACE = 'qaenv';
export const QA_USER = 'qa-user';
/** The rules of the Role above, as the API returns them. */
export const QA_RULES = [
  { apiGroups: [''], resources: ['secrets'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
  { apiGroups: [''], resources: ['configmaps'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
  { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'watch'] },
  { apiGroups: [''], resources: ['pods/log'], verbs: ['get'] },
  { apiGroups: ['apps'], resources: ['deployments'], verbs: ['get', 'list', 'watch', 'patch'] },
  { apiGroups: ['apps'], resources: ['replicasets'], verbs: ['get', 'list', 'watch'] },
];
// What every authenticated user may do (system:basic-user).
const BASIC_RULES = [
  { apiGroups: ['authorization.k8s.io'], resources: ['selfsubjectaccessreviews', 'selfsubjectrulesreviews'], verbs: ['create'] },
  { apiGroups: ['authentication.k8s.io'], resources: ['selfsubjectreviews'], verbs: ['create'] },
];

const AGO = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const meta = (namespace, name, extra = {}) => ({ name, namespace, uid: `uid-${namespace}-${name}`, resourceVersion: '1', creationTimestamp: AGO(600), ...extra });
const container = (name, image) => ({ name, image, ports: [{ containerPort: 8080, protocol: 'TCP' }], resources: {} });
const pod = (ns, name, rs, app, phase = 'Running') => ({
  apiVersion: 'v1', kind: 'Pod',
  metadata: meta(ns, name, { labels: { app }, ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: rs, uid: `uid-${ns}-${rs}`, controller: true }] }),
  spec: { nodeName: 'node-a', containers: [container(app, `registry.example/${app}:1.4.2`)] },
  status: {
    phase, podIP: '10.0.1.20', hostIP: '10.0.0.5', startTime: AGO(590),
    conditions: [{ type: 'Ready', status: phase === 'Running' ? 'True' : 'False' }],
    containerStatuses: [{ name: app, image: `registry.example/${app}:1.4.2`, ready: phase === 'Running', restartCount: 0, started: phase === 'Running', state: phase === 'Running' ? { running: { startedAt: AGO(589) } } : { waiting: { reason: 'ContainerCreating' } } }],
  },
});
const replicaSet = (ns, name, deployment, app, replicas) => ({
  apiVersion: 'apps/v1', kind: 'ReplicaSet',
  metadata: meta(ns, name, { labels: { app }, ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: deployment, uid: `uid-${ns}-${deployment}`, controller: true }] }),
  spec: { replicas, selector: { matchLabels: { app } }, template: { metadata: { labels: { app } }, spec: { containers: [container(app, `registry.example/${app}:1.4.2`)] } } },
  status: { replicas, readyReplicas: replicas, availableReplicas: replicas },
});
const deployment = (ns, name, app, replicas) => ({
  apiVersion: 'apps/v1', kind: 'Deployment',
  metadata: meta(ns, name, { labels: { app }, generation: 3 }),
  spec: { replicas, selector: { matchLabels: { app } }, strategy: { type: 'RollingUpdate' }, template: { metadata: { labels: { app } }, spec: { containers: [container(app, `registry.example/${app}:1.4.2`)] } } },
  status: { replicas, readyReplicas: replicas, availableReplicas: replicas, updatedReplicas: replicas, observedGeneration: 3, conditions: [{ type: 'Available', status: 'True' }] },
});
const configMap = (ns, name, data) => ({ apiVersion: 'v1', kind: 'ConfigMap', metadata: meta(ns, name), data });
const secret = (ns, name, data) => ({ apiVersion: 'v1', kind: 'Secret', metadata: meta(ns, name), type: 'Opaque', data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Buffer.from(v).toString('base64')])) });
const service = (ns, name, app) => ({ apiVersion: 'v1', kind: 'Service', metadata: meta(ns, name), spec: { type: 'ClusterIP', clusterIP: '172.20.0.10', selector: { app }, ports: [{ port: 80, targetPort: 8080, protocol: 'TCP' }] } });

/** What is in the cluster. Only part of qaenv is the QA user's to see. */
export function clusterObjects() {
  const objects = new Map(); // "group|resource|namespace" → [object]
  const put = (group, resource, obj) => {
    const key = `${group}|${resource}|${obj.metadata.namespace || ''}`;
    objects.set(key, [...(objects.get(key) || []), obj]);
  };
  for (const name of [QA_NAMESPACE, 'prodenv', 'default', 'kube-system'])
    put('', 'namespaces', { apiVersion: 'v1', kind: 'Namespace', metadata: { name, uid: `uid-ns-${name}`, creationTimestamp: AGO(9000), labels: { 'kubernetes.io/metadata.name': name } }, status: { phase: 'Active' } });
  put('', 'nodes', { apiVersion: 'v1', kind: 'Node', metadata: { name: 'node-a', uid: 'uid-node-a', creationTimestamp: AGO(9000) }, status: { conditions: [{ type: 'Ready', status: 'True' }] } });

  put('apps', 'deployments', deployment(QA_NAMESPACE, 'orders-api', 'orders-api', 2));
  put('apps', 'deployments', deployment(QA_NAMESPACE, 'checkout-web', 'checkout-web', 1));
  put('apps', 'replicasets', replicaSet(QA_NAMESPACE, 'orders-api-7c9d8f6b5', 'orders-api', 'orders-api', 2));
  put('apps', 'replicasets', replicaSet(QA_NAMESPACE, 'checkout-web-5f7b9c4d6', 'checkout-web', 'checkout-web', 1));
  put('', 'pods', pod(QA_NAMESPACE, 'orders-api-7c9d8f6b5-2xk4p', 'orders-api-7c9d8f6b5', 'orders-api'));
  put('', 'pods', pod(QA_NAMESPACE, 'orders-api-7c9d8f6b5-q8m7t', 'orders-api-7c9d8f6b5', 'orders-api'));
  put('', 'pods', pod(QA_NAMESPACE, 'checkout-web-5f7b9c4d6-h6n3z', 'checkout-web-5f7b9c4d6', 'checkout-web'));
  put('', 'configmaps', configMap(QA_NAMESPACE, 'orders-api-config', { LOG_LEVEL: 'debug', FEATURE_FLAGS: 'new-checkout' }));
  put('', 'configmaps', configMap(QA_NAMESPACE, 'kube-root-ca.crt', { 'ca.crt': '-----BEGIN CERTIFICATE-----' }));
  put('', 'secrets', secret(QA_NAMESPACE, 'orders-api-db', { username: 'orders', password: 'qa-only-password' }));
  // In qaenv too, but not in the Role:
  put('', 'services', service(QA_NAMESPACE, 'orders-api', 'orders-api'));
  // Other namespaces: never the QA user's.
  put('apps', 'deployments', deployment('prodenv', 'orders-api', 'orders-api', 6));
  put('', 'pods', pod('prodenv', 'orders-api-6d5c4b3a2-prod1', 'orders-api-6d5c4b3a2', 'orders-api'));
  put('', 'secrets', secret('prodenv', 'orders-api-db', { username: 'orders', password: 'PRODUCTION-PASSWORD' }));
  put('', 'pods', pod('kube-system', 'coredns-5d78c9869d-abcde', 'coredns-5d78c9869d', 'coredns'));
  return objects;
}

const KINDS = { pods: 'Pod', secrets: 'Secret', configmaps: 'ConfigMap', services: 'Service', namespaces: 'Namespace', nodes: 'Node', deployments: 'Deployment', replicasets: 'ReplicaSet', events: 'Event' };
const NAMESPACED = (resource) => !['namespaces', 'nodes', 'persistentvolumes', 'storageclasses', 'customresourcedefinitions', 'clusterroles', 'clusterrolebindings'].includes(resource);

/** /api/v1/namespaces/qaenv/pods/x/log → { group, version, namespace, resource, name, subresource } (null: not a resource path). */
export function parseResourcePath(pathname) {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  let group, version, rest;
  if (parts[0] === 'api' && parts.length > 2) [group, version, rest] = ['', parts[1], parts.slice(2)];
  else if (parts[0] === 'apis' && parts.length > 3) [group, version, rest] = [parts[1], parts[2], parts.slice(3)];
  else return null;
  let namespace = '';
  // "/namespaces/<ns>/<resource>…" is something in a namespace; "/namespaces[/<name>]" is the namespace itself.
  if (rest[0] === 'namespaces' && rest.length > 2) { namespace = rest[1]; rest = rest.slice(2); }
  const [resource, name = '', subresource = ''] = rest;
  return { group, version, namespace, resource, name, subresource };
}

function verbOf(method, { name }, query) {
  if (method === 'GET') return name ? 'get' : query.get('watch') === 'true' || query.get('watch') === '1' ? 'watch' : 'list';
  return { POST: 'create', PUT: 'update', PATCH: 'patch', DELETE: name ? 'delete' : 'deletecollection' }[method] || method.toLowerCase();
}

/** Does a Role with `rules` in `roleNamespace` allow this? (Role rules never reach outside their namespace.) */
export function allows(rules, roleNamespace, { group, namespace, resource, subresource }, verb) {
  if (namespace !== roleNamespace) return false;
  const full = subresource ? `${resource}/${subresource}` : resource;
  return rules.some((r) => (r.apiGroups.includes(group) || r.apiGroups.includes('*')) && (r.resources.includes(full) || r.resources.includes('*')) && (r.verbs.includes(verb) || r.verbs.includes('*')));
}

const forbidden = (user, verb, t) => {
  const what = t.subresource ? `${t.resource}/${t.subresource}` : t.resource;
  const where = t.namespace ? ` in the namespace "${t.namespace}"` : ' at the cluster scope';
  return {
    kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Failure', reason: 'Forbidden', code: 403,
    message: `${what} ${t.name ? `"${t.name}" ` : ''}is forbidden: User "${user}" cannot ${verb} resource "${what}" in API group "${t.group}"${where}`,
    details: { name: t.name || undefined, group: t.group || undefined, kind: t.resource },
  };
};

/**
 * Start it. { server, url, requests, objects, close() }:
 *   requests — every request it answered: { method, path, verb, status, contentType, body }
 *   objects  — the store (see clusterObjects), which PATCH / PUT / POST / DELETE change
 * Options: user, namespace, rules (the Role); clusterRules (rules that hold
 * everywhere, as from a ClusterRoleBinding: e.g. "may list namespaces");
 * incompleteRules (the rules review says it could not see everything, as with
 * a webhook authoriser).
 */
export function startRbacCluster({ user = QA_USER, namespace = QA_NAMESPACE, rules = QA_RULES, clusterRules = [], incompleteRules = false } = {}) {
  const allowed = (t, verb) => allows(rules, namespace, t, verb) || allows(clusterRules, t.namespace, t, verb);
  const objects = clusterObjects();
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://cluster');
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      const record = { method: req.method, path: url.pathname, query: url.search, contentType: req.headers['content-type'] || '', body };
      const send = (status, obj, type = 'application/json') => {
        requests.push({ ...record, status });
        res.writeHead(status, { 'Content-Type': type });
        res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
      };
      const p = url.pathname;

      // Open to every signed-in user.
      if (p === '/version') return send(200, { major: '1', minor: '33', gitVersion: 'v1.33.4-eks-fake', platform: 'linux/amd64' });
      if (p === '/api') return send(200, { kind: 'APIVersions', versions: ['v1'] });
      if (p === '/apis') return send(200, { kind: 'APIGroupList', apiVersion: 'v1', groups: [{ name: 'apps', versions: [{ groupVersion: 'apps/v1', version: 'v1' }], preferredVersion: { groupVersion: 'apps/v1', version: 'v1' } }] });
      if (p === '/api/v1') return send(200, { kind: 'APIResourceList', groupVersion: 'v1', resources: ['pods', 'secrets', 'configmaps', 'services', 'events'].map((name) => ({ name, namespaced: true, kind: KINDS[name], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] })) });
      if (p === '/apis/apps/v1') return send(200, { kind: 'APIResourceList', groupVersion: 'apps/v1', resources: ['deployments', 'replicasets'].map((name) => ({ name, namespaced: true, kind: KINDS[name], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] })) });
      if (p === '/apis/authorization.k8s.io/v1/selfsubjectrulesreviews' && req.method === 'POST') {
        const ns = body?.spec?.namespace || '';
        return send(201, {
          kind: 'SelfSubjectRulesReview', apiVersion: 'authorization.k8s.io/v1', metadata: {}, spec: { namespace: ns },
          status: { resourceRules: [...BASIC_RULES, ...clusterRules, ...(ns === namespace ? rules : [])], nonResourceRules: [{ verbs: ['get'], nonResourceURLs: ['/api', '/api/*', '/apis', '/apis/*', '/version', '/healthz'] }], incomplete: incompleteRules },
        });
      }
      if (p === '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews' && req.method === 'POST') {
        const a = body?.spec?.resourceAttributes || {};
        const ok = allowed({ group: a.group || '', namespace: a.namespace || '', resource: a.resource || '', subresource: a.subresource || '' }, a.verb || '');
        return send(201, { kind: 'SelfSubjectAccessReview', apiVersion: 'authorization.k8s.io/v1', metadata: {}, spec: body?.spec || {}, status: { allowed: ok, reason: ok ? 'RBAC: allowed' : '' } });
      }

      const t = parseResourcePath(p);
      if (!t) return send(404, { kind: 'Status', apiVersion: 'v1', status: 'Failure', reason: 'NotFound', code: 404, message: 'the server could not find the requested resource' });
      const verb = verbOf(req.method, t, url.searchParams);
      if (!allowed(t, verb)) return send(403, forbidden(user, verb, t));

      const key = `${t.group}|${t.resource}|${NAMESPACED(t.resource) ? t.namespace : ''}`;
      const items = objects.get(key) || [];
      const apiVersion = t.group ? `${t.group}/${t.version}` : t.version;
      const kind = KINDS[t.resource] || t.resource;
      const notFound = () => send(404, { kind: 'Status', apiVersion: 'v1', status: 'Failure', reason: 'NotFound', code: 404, message: `${t.resource} "${t.name}" not found` });

      if (verb === 'list') return send(200, { kind: `${kind}List`, apiVersion, metadata: { resourceVersion: '100' }, items });
      if (verb === 'watch') return send(200, '', 'application/json');
      const found = items.find((o) => o.metadata.name === t.name);
      if (verb === 'create') {
        const created = { ...body, metadata: meta(t.namespace, body?.metadata?.name, body?.metadata) };
        objects.set(key, [...items, created]);
        return send(201, created);
      }
      if (!found) return notFound();
      if (verb === 'get') return t.subresource === 'log' ? send(200, `${AGO(3)} started ${t.name}\n${AGO(2)} listening on :8080\n${AGO(1)} GET /healthz 200\n`, 'text/plain') : send(200, found);
      if (verb === 'delete') { objects.set(key, items.filter((o) => o !== found)); return send(200, { kind: 'Status', apiVersion: 'v1', status: 'Success' }); }
      if (verb === 'update') { objects.set(key, items.map((o) => (o === found ? { ...body, metadata: { ...found.metadata, ...body?.metadata } } : o))); return send(200, body); }
      if (verb === 'patch') {
        // A merge of what a restart, a scale or an edit sends: enough to see what was asked.
        const merge = (a, b) => (b && typeof b === 'object' && !Array.isArray(b) ? Object.fromEntries([...new Set([...Object.keys(a || {}), ...Object.keys(b)])].map((k) => [k, k in b ? merge(a?.[k], b[k]) : a[k]])) : b);
        const next = merge(found, body);
        objects.set(key, items.map((o) => (o === found ? next : o)));
        return send(200, next);
      }
      return send(405, { kind: 'Status', apiVersion: 'v1', status: 'Failure', code: 405, message: 'method not allowed' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, url, requests, objects, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) });
    });
  });
}

/** A kubeconfig for it: one context, signed in with a token (as after AWS sign-in), no namespace named. */
export const kubeconfigFor = (url, { context = 'qa-eks', namespace } = {}) => `apiVersion: v1
kind: Config
current-context: ${context}
clusters:
- name: ${context}
  cluster: { server: '${url}', insecure-skip-tls-verify: true }
users:
- name: ${context}
  user: { token: qa-user-token }
contexts:
- name: ${context}
  context: { cluster: ${context}, user: ${context}${namespace ? `, namespace: ${namespace}` : ''} }
`;
