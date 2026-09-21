// Argo CD status → tone (the app-wide palette in lib/status.js; the explicit
// maps below pin the contract for the values Argo reports, statusTone() covers
// anything else). Synced/Healthy → ok, OutOfSync/Progressing/Suspended → warn,
// Degraded/Missing/Unknown → bad.
import { statusTone } from '../../lib/status';

export const SYNC_ORDER = ['Synced', 'OutOfSync', 'Unknown'];
export const HEALTH_ORDER = ['Healthy', 'Progressing', 'Degraded', 'Missing', 'Suspended', 'Unknown'];

const SYNC_TONE = { Synced: 'ok', OutOfSync: 'warn', Unknown: 'bad' };
const HEALTH_TONE = { Healthy: 'ok', Progressing: 'warn', Suspended: 'warn', Degraded: 'bad', Missing: 'bad', Unknown: 'bad' };

export const syncTone = (s) => SYNC_TONE[s] || statusTone('argocd', s);
export const healthTone = (h) => HEALTH_TONE[h] || statusTone('argocd', h);

/** Operation phase (Succeeded / Failed / Error / Running …). */
export const opTone = (phase) => {
  if (phase === 'Succeeded') return 'ok';
  if (phase === 'Failed' || phase === 'Error') return 'bad';
  return 'info';
};

export const shortRepo = (url) => (url ? url.replace(/^https?:\/\//, '').replace(/\.git$/, '') : '');
export const appKey = (a) => `${a.namespace}/${a.name}`;
export const sameApp = (a, b) => !!a && !!b && a.name === b.name && a.namespace === b.namespace;

export const needsAttention = (a) => a.syncStatus !== 'Synced' || (a.healthStatus !== 'Healthy' && a.healthStatus !== 'Unknown');
export const resourceNeedsAttention = (r) => r.syncStatus !== 'Synced' || (r.healthStatus && r.healthStatus !== 'Healthy');
export const resourceKey = (r) => `${r.kind}|${r.namespace || ''}|${r.name}`;

// Short kind labels shown under the glyph in the graph, matching the Argo CD tree.
const SHORT_KIND = {
  Application: 'application', Service: 'svc', ServiceAccount: 'sa', Deployment: 'deploy',
  ReplicaSet: 'rs', StatefulSet: 'sts', DaemonSet: 'ds', Pod: 'pod', ConfigMap: 'cm',
  Secret: 'secret', ExternalSecret: 'externalsecret', SecretStore: 'secretstore', ClusterSecretStore: 'clustersecretstore',
  Ingress: 'ing', IngressClass: 'ingressclass', ServiceMonitor: 'servicemonitor', PodMonitor: 'podmonitor',
  Job: 'job', CronJob: 'cronjob', NetworkPolicy: 'netpol', HorizontalPodAutoscaler: 'hpa',
  PersistentVolumeClaim: 'pvc', PersistentVolume: 'pv', Role: 'role', RoleBinding: 'rolebinding',
  ClusterRole: 'clusterrole', ClusterRoleBinding: 'clusterrolebinding', PodDisruptionBudget: 'pdb',
  CustomResourceDefinition: 'crd', ValidatingWebhookConfiguration: 'webhook', Certificate: 'cert',
};
export const shortKind = (k) => SHORT_KIND[k] || (k || '').toLowerCase();

export { tablistKeys } from '../shared/tabs';
