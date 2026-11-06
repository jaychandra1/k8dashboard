// Health counts for the Dashboard (GET /api/cluster/summary), cluster-wide.
//
// Pods: a pod's phase alone hides most failures — a container in
// CrashLoopBackOff or ImagePullBackOff still has phase "Running". A pod is
// counted as failing when one of its containers waits or ended with a failure
// reason, whatever its phase says. This is the same rule as the UI's
// podPhaseBucket (client/src/lib/status.js); test/cluster-health.test.mjs keeps
// the two in step.
//
// Workloads: how many of each kind there are and how many are not where they
// should be (deployments/statefulsets/daemonsets without all replicas ready,
// failed jobs, suspended cronjobs).

export const POD_BUCKETS = ['running', 'pending', 'failed', 'succeeded', 'unknown'];

// Failure reasons, as in client/src/lib/status.js (BAD).
const BAD = new Set([
  'failed', 'crashloopbackoff', 'error', 'imagepullbackoff', 'errimagepull', 'oomkilled', 'evicted', 'notready',
  'degraded', 'missing', 'false', 'invalidimagename', 'createcontainerconfigerror', 'createcontainererror',
  'runcontainererror', 'deadlineexceeded', 'backoff', 'critical', 'high', 'fail', 'uninstalling', 'unhealthy',
  'lost', 'unreachable', 'unauthorized', 'forbidden',
]);
const lower = (s) => String(s || '').toLowerCase();

/** 'running' | 'pending' | 'failed' | 'succeeded' | 'unknown' for a Kubernetes Pod object. */
export function podBucket(pod) {
  if (!pod) return 'unknown';
  const containers = [].concat(pod.status?.containerStatuses || []);
  const reasons = containers
    .map((c) => lower(c?.state?.waiting?.reason || c?.state?.terminated?.reason || c?.reason))
    .filter(Boolean);
  if (reasons.some((r) => BAD.has(r))) return 'failed';
  const phase = lower(pod.status?.phase);
  if (phase === 'running') return 'running';
  if (phase === 'succeeded') return 'succeeded';
  if (phase === 'failed') return 'failed';
  if (phase === 'pending') return 'pending';
  return 'unknown';
}

/** Add `pod` to a bucket count object (created on first use). */
export function countPod(counts, pod) {
  const c = counts || Object.fromEntries(POD_BUCKETS.map((b) => [b, 0]));
  c[podBucket(pod)] += 1;
  return c;
}

const desired = (o, fallback = 1) => (o?.spec?.replicas ?? fallback);
const conditionTrue = (o, type) => (o?.status?.conditions || []).some((c) => c?.type === type && c?.status === 'True');

/** Per-object state for one workload kind. */
const STATE = {
  deployments: (d) => (desired(d) === 0 ? 'scaledDown' : (d.status?.availableReplicas ?? 0) >= desired(d) ? 'ready' : 'notReady'),
  statefulSets: (s) => (desired(s) === 0 ? 'scaledDown' : (s.status?.readyReplicas ?? 0) >= desired(s) ? 'ready' : 'notReady'),
  daemonSets: (d) => ((d.status?.numberReady ?? 0) >= (d.status?.desiredNumberScheduled ?? 0) ? 'ready' : 'notReady'),
  jobs: (j) => (conditionTrue(j, 'Failed') ? 'failed' : conditionTrue(j, 'Complete') ? 'complete' : 'active'),
  cronJobs: (c) => (c.spec?.suspend ? 'suspended' : 'scheduled'),
  services: () => 'ok',
};
export const WORKLOAD_KINDS = Object.keys(STATE);

/** { total, <state>: n, … } for a list of objects of one kind. */
export function workloadSummary(kind, items) {
  const state = STATE[kind];
  if (!state) throw new Error(`unknown workload kind "${kind}"`);
  const out = { total: 0 };
  for (const item of items || []) {
    const s = state(item);
    out.total += 1;
    out[s] = (out[s] || 0) + 1;
  }
  return out;
}
