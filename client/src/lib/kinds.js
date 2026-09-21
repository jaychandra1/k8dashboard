// The resource-type registry — ONE source of truth for every view key the app
// routes on. Replaces App.jsx's PLURAL_KEY / CLUSTER_SCOPED /
// STANDALONE_RESOURCE_TYPES, the nav lists in Navigation.jsx and
// CommandPalette.jsx, RESOURCE_LABELS in ResourceViewer.jsx, and the three
// KIND_ICON copies (ResourceDrawer / Topology / ArgoCD).
//
// Shape: { key, label, singular, plural, apiKind, icon, group, clusterScoped, standalone }
//   key          camelCase view key used in state / routes ('statefulSet')
//   label        sidebar / heading label ('StatefulSets')
//   singular     'StatefulSet'
//   plural       key under which the list lives in allResources ('statefulSets')
//   apiKind      Kubernetes Kind ('StatefulSet') — null for non-k8s views
//   icon         Icons.jsx name
//   group        'cluster' | 'workloads' | 'network' | 'storage' | 'config' | 'other' | 'app'
//   clusterScoped true → one /api/storage call instead of per-namespace
//   standalone   true → the view loads its own data (no shared resource fetch)

const T = (key, label, singular, apiKind, icon, group, extra = {}) => ({
  key, label, singular, apiKind, icon, group,
  plural: extra.plural || `${key}s`,
  clusterScoped: !!extra.clusterScoped,
  standalone: !!extra.standalone,
  hidden: !!extra.hidden,
});

export const RESOURCE_TYPES = [
  // App-level / cluster views
  T('overview', 'Overview', 'Overview', null, 'overview', 'cluster', { standalone: false }),
  T('cluster', 'Cluster', 'Cluster', null, 'cluster', 'cluster', { standalone: true }),
  T('nodes', 'Nodes', 'Node', 'Node', 'nodes', 'cluster', { standalone: true, clusterScoped: true, plural: 'nodes' }),
  T('namespaces', 'Namespaces', 'Namespace', 'Namespace', 'namespace', 'cluster', { standalone: true, clusterScoped: true, plural: 'namespaces' }),
  T('topology', 'Topology', 'Topology', null, 'topology', 'cluster', { standalone: true }),
  T('events', 'Events', 'Event', 'Event', 'events', 'other'),

  // Workloads
  T('pod', 'Pods', 'Pod', 'Pod', 'pod', 'workloads'),
  T('deployment', 'Deployments', 'Deployment', 'Deployment', 'deployment', 'workloads'),
  T('statefulSet', 'StatefulSets', 'StatefulSet', 'StatefulSet', 'statefulSet', 'workloads'),
  T('daemonSet', 'DaemonSets', 'DaemonSet', 'DaemonSet', 'daemonSet', 'workloads'),
  T('replicaSet', 'Replica Sets', 'ReplicaSet', 'ReplicaSet', 'replicaSet', 'workloads'),
  T('replicationController', 'Replication Controllers', 'ReplicationController', 'ReplicationController', 'replicationController', 'workloads'),
  T('job', 'Jobs', 'Job', 'Job', 'job', 'workloads'),
  T('cronJob', 'Cron Jobs', 'CronJob', 'CronJob', 'cronJob', 'workloads'),

  // Network
  T('service', 'Services', 'Service', 'Service', 'service', 'network'),
  T('ingress', 'Ingress', 'Ingress', 'Ingress', 'ingress', 'network', { plural: 'ingresses' }),
  T('networkPolicy', 'Network Policies', 'NetworkPolicy', 'NetworkPolicy', 'networkPolicy', 'network', { plural: 'networkPolicies' }),

  // Storage
  T('persistentVolume', 'PersistentVolumes', 'PersistentVolume', 'PersistentVolume', 'persistentVolume', 'storage', { clusterScoped: true }),
  T('persistentVolumeClaim', 'PersistentVolumeClaims', 'PersistentVolumeClaim', 'PersistentVolumeClaim', 'persistentVolumeClaim', 'storage'),
  T('storageClass', 'StorageClasses', 'StorageClass', 'StorageClass', 'storageClass', 'storage', { clusterScoped: true, plural: 'storageClasses' }),

  // Config
  T('configMap', 'ConfigMaps', 'ConfigMap', 'ConfigMap', 'configMap', 'config'),
  T('secret', 'Secrets', 'Secret', 'Secret', 'secret', 'config'),
  T('serviceAccount', 'ServiceAccounts', 'ServiceAccount', 'ServiceAccount', 'serviceAccount', 'config'),

  // Other standalone views
  T('helm', 'Helm', 'Helm release', null, 'helm', 'other', { standalone: true }),
  T('customResources', 'Custom Resources', 'Custom Resource', null, 'customResources', 'other', { standalone: true }),
  T('accessControl', 'Access Control', 'Access Control', null, 'accessControl', 'other', { standalone: true }),
  T('argocd', 'Argo CD', 'Argo CD', null, 'argocd', 'app', { standalone: true }),
  T('security', 'Security', 'Security', null, 'shield', 'app', { standalone: true }),
  T('preferences', 'Preferences', 'Preferences', null, 'settings', 'app', { standalone: true, hidden: true }),
];

/** key → descriptor */
export const byKey = Object.fromEntries(RESOURCE_TYPES.map((t) => [t.key, t]));

/** apiKind ('StatefulSet') → view key ('statefulSet') */
export const byApiKind = Object.fromEntries(RESOURCE_TYPES.filter((t) => t.apiKind).map((t) => [t.apiKind, t.key]));

export const KEYS = RESOURCE_TYPES.map((t) => t.key);

/** Key the list lives under in allResources ('ingress' → 'ingresses'). */
export function pluralKey(key) {
  return byKey[key]?.plural || `${key}s`;
}

export function isClusterScoped(key) {
  return !!byKey[key]?.clusterScoped;
}

/** Views that load their own data (no shared per-namespace resource fetch). */
export function isStandalone(key) {
  return !!byKey[key]?.standalone;
}

export const STANDALONE_KEYS = RESOURCE_TYPES.filter((t) => t.standalone).map((t) => t.key);
export const CLUSTER_SCOPED_KEYS = RESOURCE_TYPES.filter((t) => t.clusterScoped && !t.standalone).map((t) => t.key);

/** { label, icon } for a view key — the ResourceViewer header uses this. */
export function labelFor(key) {
  const t = byKey[key];
  return t ? { label: t.label, icon: t.icon, singular: t.singular } : { label: key, icon: 'box', singular: key };
}

/** Types in a nav group, in registry order. */
export function typesInGroup(group) {
  return RESOURCE_TYPES.filter((t) => t.group === group && !t.hidden);
}

/** Sidebar groups in display order. */
export const NAV_GROUPS = [
  { key: 'cluster', label: 'Cluster' },
  { key: 'workloads', label: 'Workloads' },
  { key: 'network', label: 'Network' },
  { key: 'storage', label: 'Storage' },
  { key: 'config', label: 'Config' },
  { key: 'other', label: 'Other' },
];

/**
 * Kubernetes Kind → Icons.jsx name. Merged superset of the three former copies
 * (ResourceDrawer, Topology, ArgoCD G_KIND_ICON). Unknown kinds → 'box'.
 */
export const KIND_ICON = {
  ...Object.fromEntries(RESOURCE_TYPES.filter((t) => t.apiKind).map((t) => [t.apiKind, t.icon])),
  Role: 'accessControl', ClusterRole: 'accessControl', RoleBinding: 'accessControl', ClusterRoleBinding: 'accessControl',
  IngressClass: 'ingress', Endpoints: 'service', EndpointSlice: 'service',
  ExternalSecret: 'secret', SecretStore: 'secret', ClusterSecretStore: 'secret',
  Certificate: 'secret', Issuer: 'secret', ClusterIssuer: 'secret',
  ServiceMonitor: 'activity', PodMonitor: 'activity',
  HorizontalPodAutoscaler: 'scale', Rollout: 'deployment',
  PodDisruptionBudget: 'box', CustomResourceDefinition: 'customResources',
  ValidatingWebhookConfiguration: 'accessControl', MutatingWebhookConfiguration: 'accessControl',
  Application: 'argocd', ApplicationSet: 'argocd', AppProject: 'accessControl',
  Namespace: 'namespace', Node: 'nodes',
};

export const kindIcon = (kind) => KIND_ICON[kind] || 'box';

/**
 * Kubernetes Kind → view key (Trivy / owner references report PascalCase
 * kinds; the app routes on camelCase keys). RBAC kinds → the Access Control view.
 */
export const KIND_TYPE = {
  ...byApiKind,
  Role: 'accessControl', ClusterRole: 'accessControl', RoleBinding: 'accessControl', ClusterRoleBinding: 'accessControl',
};
export const kindType = (k) => KIND_TYPE[k] || (k || '').toLowerCase();

/** Installed CLI agent id → Icons.jsx name (was private in aiConfig.js). */
export const AGENT_ICON = { claude: 'aiClaude', copilot: 'aiCopilot', gemini: 'aiGemini', codex: 'aiCodex', opencode: 'aiOpencode' };
