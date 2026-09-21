import { describe, it, expect } from 'vitest';
import { RESOURCE_TYPES, byKey, pluralKey, isClusterScoped, isStandalone, STANDALONE_KEYS, CLUSTER_SCOPED_KEYS, KIND_ICON, kindIcon, kindType, labelFor, typesInGroup, AGENT_ICON } from './kinds';

describe('kinds registry', () => {
  it('has unique keys and every legacy App.jsx key', () => {
    const keys = RESOURCE_TYPES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of ['overview', 'cluster', 'nodes', 'namespaces', 'helm', 'customResources', 'accessControl', 'topology', 'argocd', 'security',
      'pod', 'deployment', 'statefulSet', 'daemonSet', 'replicaSet', 'replicationController', 'job', 'cronJob',
      'service', 'ingress', 'networkPolicy', 'persistentVolume', 'persistentVolumeClaim', 'storageClass',
      'configMap', 'secret', 'serviceAccount', 'events', 'preferences']) {
      expect(byKey[k], k).toBeTruthy();
    }
  });
  it('pluralKey matches the old PLURAL_KEY special cases', () => {
    expect(pluralKey('ingress')).toBe('ingresses');
    expect(pluralKey('networkPolicy')).toBe('networkPolicies');
    expect(pluralKey('storageClass')).toBe('storageClasses');
    expect(pluralKey('pod')).toBe('pods');
    expect(pluralKey('unknownThing')).toBe('unknownThings');
  });
  it('cluster-scoped and standalone sets match App.jsx', () => {
    expect(CLUSTER_SCOPED_KEYS).toEqual(['persistentVolume', 'storageClass']);
    expect(isClusterScoped('persistentVolume')).toBe(true);
    expect(isClusterScoped('pod')).toBe(false);
    for (const k of ['cluster', 'nodes', 'namespaces', 'helm', 'customResources', 'accessControl', 'topology', 'argocd', 'security']) {
      expect(STANDALONE_KEYS).toContain(k);
    }
    expect(isStandalone('overview')).toBe(false);
    expect(isStandalone('pod')).toBe(false);
  });
  it('KIND_ICON merges all three former maps', () => {
    expect(KIND_ICON.Pod).toBe('pod');
    expect(KIND_ICON.ClusterRoleBinding).toBe('accessControl');
    expect(KIND_ICON.ExternalSecret).toBe('secret');
    expect(KIND_ICON.HorizontalPodAutoscaler).toBe('scale');
    expect(kindIcon('SomethingElse')).toBe('box');
  });
  it('kindType maps PascalCase kinds to view keys', () => {
    expect(kindType('StatefulSet')).toBe('statefulSet');
    expect(kindType('Role')).toBe('accessControl');
    expect(kindType('Foo')).toBe('foo');
  });
  it('labels and groups', () => {
    expect(labelFor('statefulSet')).toEqual({ label: 'StatefulSets', icon: 'statefulSet', singular: 'StatefulSet' });
    expect(typesInGroup('network').map((t) => t.key)).toEqual(['service', 'ingress', 'networkPolicy']);
    expect(typesInGroup('app').map((t) => t.key)).not.toContain('preferences');
    expect(AGENT_ICON.claude).toBe('aiClaude');
  });
});
