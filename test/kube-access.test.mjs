// lib/kube-access.mjs: reading the API's "no", saying it without the user's
// identity, what a rules review means for a namespace, and the namespaces a
// user named per cluster.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  kubeStatus, isForbidden, deniedAction, forbiddenMessage, namespaceAccess,
  isNamespaceName, knownNamespaces, withKnownNamespace, withoutKnownNamespace, MAX_KNOWN_NAMESPACES,
} from '../lib/kube-access.mjs';
import { mapUpstreamError } from '../lib/http-errors.mjs';
import { shortReason } from '../lib/cluster-network.mjs';

// On EKS the API names the IAM role session: account ID and (often) an e-mail address.
const WHO = 'arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_QA_0123456789abcdef/jane.doe@example.com';
const status = (message, code = 403, reason = 'Forbidden') => ({ kind: 'Status', apiVersion: 'v1', status: 'Failure', reason, code, message });
/** The error the Kubernetes client throws for a status it doesn't model: the body is text. */
const apiError = (st) => Object.assign(new Error(`HTTP-Code: ${st.code}\nMessage: Unknown API Status Code!\nBody: ${JSON.stringify(JSON.stringify(st))}\nHeaders: {}`), { code: st.code, body: JSON.stringify(st), headers: {} });
const refusal = (verb, resource, group, namespace) =>
  apiError(status(`${resource} is forbidden: User "${WHO}" cannot ${verb} resource "${resource}" in API group "${group}"${namespace ? ` in the namespace "${namespace}"` : ' at the cluster scope'}`));

describe('what the API said', () => {
  test('the Status is found as an object, as the text the client hands over, or not at all', () => {
    const st = status('nope');
    assert.deepEqual(kubeStatus({ body: st }), st);
    assert.deepEqual(kubeStatus({ body: JSON.stringify(st) }), st);
    assert.deepEqual(kubeStatus({ body: `  ${JSON.stringify(st)}\n` }), st);
    for (const body of [undefined, null, '', 'Forbidden', '{not json', '[1,2]x', 7, Buffer.from('{}')]) assert.equal(kubeStatus({ body }), null, String(body));
    assert.equal(kubeStatus(null), null);
  });

  test('forbidden: an HTTP 403 from the API, or kubectl saying so — not a failed sign-in, not a 404', () => {
    assert.equal(isForbidden(refusal('list', 'pods', '', 'qaenv')), true);
    assert.equal(isForbidden({ statusCode: 403 }), true);
    assert.equal(isForbidden({ body: status('x') }), true);
    assert.equal(isForbidden({ code: 1, stderr: `Error from server (Forbidden): pods is forbidden: User "${WHO}" cannot list resource "pods"` }), true);
    for (const e of [apiError(status('Unauthorized', 401, 'Unauthorized')), apiError(status('not found', 404, 'NotFound')), new Error('fetch failed'), { code: 'ENOTFOUND' }, null, undefined])
      assert.equal(isForbidden(e), false);
  });

  test('what was refused: verb, resource, API group, namespace', () => {
    assert.deepEqual(deniedAction(refusal('list', 'namespaces', '', '')), { verb: 'list', resource: 'namespaces', group: '', namespace: '' });
    assert.deepEqual(deniedAction(refusal('patch', 'deployments/scale', 'apps', 'qaenv')), { verb: 'patch', resource: 'deployments/scale', group: 'apps', namespace: 'qaenv' });
    assert.deepEqual(deniedAction({ code: 1, stderr: `Error from server (Forbidden): pods "x" is forbidden: User "${WHO}" cannot delete resource "pods" in API group "" in the namespace "qaenv"` }),
      { verb: 'delete', resource: 'pods', group: '', namespace: 'qaenv' });
    // A refusal that doesn't say (a webhook's own words), or no refusal at all.
    assert.equal(deniedAction(apiError(status('access denied by policy'))), null);
    assert.equal(deniedAction(new Error('boom')), null);
  });

  test('said in plain words, by action — and never with who was refused', () => {
    const say = (...a) => forbiddenMessage(deniedAction(refusal(...a)));
    assert.equal(say('list', 'namespaces', '', ''), "You don't have permission to list namespaces.");
    assert.equal(say('list', 'pods', '', 'qaenv'), "You don't have permission to list pods in namespace qaenv.");
    assert.equal(say('get', 'secrets', '', 'prodenv'), "You don't have permission to view secrets in namespace prodenv.");
    assert.equal(say('patch', 'deployments', 'apps', 'qaenv'), "You don't have permission to change deployments in namespace qaenv.");
    assert.equal(say('update', 'configmaps', '', 'qaenv'), "You don't have permission to change configmaps in namespace qaenv.");
    assert.equal(say('delete', 'pods', '', 'qaenv'), "You don't have permission to delete pods in namespace qaenv.");
    assert.equal(say('patch', 'deployments/scale', 'apps', 'qaenv'), "You don't have permission to scale deployments in namespace qaenv.");
    assert.equal(say('get', 'pods/log', '', 'qaenv'), "You don't have permission to read pod logs in namespace qaenv.");
    assert.equal(say('create', 'pods/exec', '', 'qaenv'), "You don't have permission to open a terminal in pods in namespace qaenv.");
    assert.equal(say('create', 'pods/portforward', '', 'qaenv'), "You don't have permission to forward ports of pods in namespace qaenv.");
    assert.equal(say('get', 'nodes/proxy', '', ''), "You don't have permission to view nodes (proxy).");
    assert.equal(forbiddenMessage(null), "You don't have permission to do this on this cluster.");
  });

  test('the answer a request gets: 403 "forbidden", our sentence, what was refused — no identity, no dump', () => {
    const mapped = mapUpstreamError(refusal('list', 'pods', '', 'prodenv'));
    assert.deepEqual(mapped, {
      status: 403, code: 'forbidden', error: "You don't have permission to list pods in namespace prodenv.",
      denied: { verb: 'list', resource: 'pods', group: '', namespace: 'prodenv' },
    });
    const vague = mapUpstreamError(apiError(status(`User "${WHO}" is not allowed by policy`)));
    assert.deepEqual(vague, { status: 403, code: 'forbidden', error: "You don't have permission to do this on this cluster." });
    for (const m of [mapped, vague, mapUpstreamError({ code: 1, stderr: `Error from server (Forbidden): pods is forbidden: User "${WHO}" cannot list resource "pods" in API group "" in the namespace "qaenv"` })]) {
      assert.doesNotMatch(JSON.stringify(m), /123456789012|jane\.doe|arn:aws|HTTP-Code|Headers/);
      assert.equal(m.status, 403);
    }
  });

  test('other failures say the API\'s own sentence instead of a dump of the response', () => {
    assert.deepEqual(mapUpstreamError(apiError(status('deployments.apps "web" not found', 404, 'NotFound'))), { status: 404, error: 'deployments.apps "web" not found', code: 'not_found' });
    assert.deepEqual(mapUpstreamError(apiError(status('Operation cannot be fulfilled on configmaps "x": the object has been modified', 409, 'Conflict'))),
      { status: 409, error: 'Operation cannot be fulfilled on configmaps "x": the object has been modified', code: 'conflict' });
    assert.equal(mapUpstreamError(apiError(status('Unauthorized', 401, 'Unauthorized'))).error, 'Unauthorized');
    assert.equal(mapUpstreamError(apiError(status('etcdserver: request timed out', 500, 'InternalError'))).error, 'etcdserver: request timed out');
  });

  test('in a list of what could not be loaded: "no permission"', () => {
    assert.equal(shortReason(refusal('list', 'services', '', 'qaenv')), 'no permission');
    assert.equal(shortReason(apiError(status('etcdserver: request timed out', 500, 'InternalError'))), 'etcdserver: request timed out');
    assert.equal(shortReason(new Error('first line\nsecond')), 'first line');
  });
});

describe('what a user may do in a namespace (rules review)', () => {
  const SELF = [
    { apiGroups: ['authorization.k8s.io'], resources: ['selfsubjectaccessreviews', 'selfsubjectrulesreviews'], verbs: ['create'] },
    { apiGroups: ['authentication.k8s.io'], resources: ['selfsubjectreviews'], verbs: ['create'] },
  ];
  test('asking about yourself is not access to a namespace', () => {
    assert.deepEqual(namespaceAccess({ resourceRules: SELF }), { any: false, incomplete: false, list: [] });
    assert.deepEqual(namespaceAccess({}), { any: false, incomplete: false, list: [] });
    assert.deepEqual(namespaceAccess(undefined), { any: false, incomplete: false, list: [] });
  });

  test('a Role: access, and what can be listed (sub-resources and write-only rules are not lists)', () => {
    const a = namespaceAccess({ resourceRules: [
      ...SELF,
      { apiGroups: [''], resources: ['secrets', 'configmaps'], verbs: ['get', 'list', 'watch', 'update'] },
      { apiGroups: [''], resources: ['pods/log'], verbs: ['get'] },
      { apiGroups: ['apps'], resources: ['deployments'], verbs: ['get', 'list', 'patch'] },
      { apiGroups: ['batch'], resources: ['jobs'], verbs: ['create'] },
    ] });
    assert.deepEqual(a, { any: true, incomplete: false, list: ['configmaps', 'deployments.apps', 'secrets'] });
    assert.deepEqual(namespaceAccess({ resourceRules: [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }] }).list, ['*']);
  });

  test('a cluster that could not see every rule says so', () => {
    assert.deepEqual(namespaceAccess({ resourceRules: SELF, incomplete: true }), { any: false, incomplete: true, list: [] });
  });
});

describe('the namespaces a user named, per cluster', () => {
  test('a namespace name', () => {
    for (const ok of ['qaenv', 'qa-env', 'a', 'team-1', 'a'.repeat(63)]) assert.equal(isNamespaceName(ok), true, ok);
    for (const bad of ['', 'QA', 'qa_env', '-qa', 'qa-', 'a'.repeat(64), 'qa env', 'qa/env', '..', null, 7, {}]) assert.equal(isNamespaceName(bad), false, String(bad));
  });

  const entry = (context, ...namespaces) => ({ context, namespaces });

  test('the list: the ones added for this cluster and the kubeconfig context\'s, sorted, each once', () => {
    const settings = { knownNamespaces: [entry('qa-eks', 'zeta', 'qaenv', 'qaenv', 'Not_A_Name', 7), entry('other', 'prod')] };
    assert.deepEqual(knownNamespaces(settings, 'qa-eks', null), ['qaenv', 'zeta']);
    assert.deepEqual(knownNamespaces(settings, 'qa-eks', 'alpha'), ['alpha', 'qaenv', 'zeta']);
    assert.deepEqual(knownNamespaces(settings, 'qa-eks', 'qaenv'), ['qaenv', 'zeta']);
    assert.deepEqual(knownNamespaces(settings, 'nobody', 'Bad_Name'), []);
    // Anything that isn't the list of entries reads as "none".
    const notLists = [
      undefined, {}, { knownNamespaces: null }, { knownNamespaces: 'x' }, { knownNamespaces: { 'qa-eks': ['qaenv'] } },
      { knownNamespaces: [null, 'qa-eks', { context: 'qa-eks' }, { context: 7, namespaces: ['x'] }, { context: 'qa-eks', namespaces: 'qaenv' }] },
    ];
    for (const s of notLists) assert.deepEqual(knownNamespaces(s, 'qa-eks'), []);
  });

  test('a cluster\'s name is a value, never a property name', () => {
    // Names that are an object's built-ins are contexts like any other, and stay apart.
    let s = {};
    for (const [context, ns] of [['__proto__', 'ns-a'], ['constructor', 'ns-b'], ['toString', 'ns-c'], ['qa-eks', 'ns-d']]) s = { knownNamespaces: withKnownNamespace(s, context, ns) };
    assert.deepEqual(s.knownNamespaces, [entry('__proto__', 'ns-a'), entry('constructor', 'ns-b'), entry('qa-eks', 'ns-d'), entry('toString', 'ns-c')]);
    assert.deepEqual(knownNamespaces(s, '__proto__'), ['ns-a']);
    assert.deepEqual(knownNamespaces(s, 'hasOwnProperty'), []);
    assert.equal({}.namespaces, undefined);
    assert.equal(Object.getPrototypeOf(s.knownNamespaces), Array.prototype);
    // It survives the file it is kept in.
    assert.deepEqual(JSON.parse(JSON.stringify(s)).knownNamespaces, s.knownNamespaces);
  });

  test('adding and removing change one cluster only, and leave the setting tidy', () => {
    let s = { knownNamespaces: [entry('other', 'prod')], mcpAllowWrite: true };
    s = { ...s, knownNamespaces: withKnownNamespace(s, 'qa-eks', 'qaenv') };
    s = { ...s, knownNamespaces: withKnownNamespace(s, 'qa-eks', 'alpha') };
    s = { ...s, knownNamespaces: withKnownNamespace(s, 'qa-eks', 'qaenv') };
    assert.deepEqual(s.knownNamespaces, [entry('other', 'prod'), entry('qa-eks', 'alpha', 'qaenv')]);
    assert.deepEqual(withKnownNamespace(s, 'qa-eks', 'Bad_Name'), s.knownNamespaces);
    assert.deepEqual(withKnownNamespace(s, '', 'x'), s.knownNamespaces);
    s = { ...s, knownNamespaces: withoutKnownNamespace(s, 'qa-eks', 'alpha') };
    assert.deepEqual(s.knownNamespaces, [entry('other', 'prod'), entry('qa-eks', 'qaenv')]);
    assert.deepEqual(withoutKnownNamespace(s, 'qa-eks', 'qaenv'), [entry('other', 'prod')], 'a cluster left with none is dropped');
    assert.deepEqual(withoutKnownNamespace(s, 'other'), [entry('qa-eks', 'qaenv')], 'a removed cluster takes its list with it');
    assert.deepEqual(withoutKnownNamespace({}, 'x', 'y'), []);
    // A cluster listed twice in the file counts once.
    assert.deepEqual(withKnownNamespace({ knownNamespaces: [entry('c', 'a'), entry('c', 'b')] }, 'c', 'z'), [entry('c', 'a', 'z')]);
  });

  test('a cluster keeps at most MAX_KNOWN_NAMESPACES', () => {
    let s = {};
    for (let i = 0; i < MAX_KNOWN_NAMESPACES + 10; i++) s = { knownNamespaces: withKnownNamespace(s, 'c', `ns-${String(i).padStart(3, '0')}`) };
    assert.equal(s.knownNamespaces[0].namespaces.length, MAX_KNOWN_NAMESPACES);
  });
});
