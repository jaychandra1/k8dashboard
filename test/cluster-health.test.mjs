// Dashboard health counts (lib/cluster-health.mjs): pods are bucketed like the
// UI does (a crash-looping pod is failing, not running), workloads report how
// many are not ready, and the summary carries both.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { podBucket, countPod, workloadSummary, POD_BUCKETS, WORKLOAD_KINDS } from '../lib/cluster-health.mjs';
import { podPhaseBucket } from '../client/src/lib/status.js';
import { startServer } from './helpers/server.mjs';

const pod = (phase, ...states) => ({ status: { phase, containerStatuses: states.map((state) => ({ state })) } });
const PODS = {
  running: pod('Running', { running: {} }),
  crashLoop: pod('Running', { waiting: { reason: 'CrashLoopBackOff' } }),
  imagePull: pod('Pending', { waiting: { reason: 'ImagePullBackOff' } }),
  creating: pod('Pending', { waiting: { reason: 'ContainerCreating' } }),
  oomKilled: pod('Running', { terminated: { reason: 'OOMKilled' } }),
  completed: pod('Succeeded', { terminated: { reason: 'Completed' } }),
  failed: pod('Failed', { terminated: { reason: 'Error' } }),
  evicted: { status: { phase: 'Failed', reason: 'Evicted' } },
  sidecarOk: pod('Running', { running: {} }, { running: {} }),
  oneBad: pod('Running', { running: {} }, { waiting: { reason: 'CreateContainerConfigError' } }),
  unknown: { status: { phase: 'Unknown' } },
  empty: {},
};

describe('podBucket', () => {
  test('a failing container makes the pod failing, whatever its phase says', () => {
    assert.equal(podBucket(PODS.crashLoop), 'failed');
    assert.equal(podBucket(PODS.imagePull), 'failed');
    assert.equal(podBucket(PODS.oomKilled), 'failed');
    assert.equal(podBucket(PODS.oneBad), 'failed');
    assert.equal(podBucket(PODS.running), 'running');
    assert.equal(podBucket(PODS.creating), 'pending');
    assert.equal(podBucket(PODS.completed), 'succeeded');
    assert.equal(podBucket(PODS.evicted), 'failed');
    assert.equal(podBucket(PODS.unknown), 'unknown');
  });

  test('same answer as the UI (client/src/lib/status.js podPhaseBucket) for every case', () => {
    for (const [name, p] of Object.entries(PODS)) assert.equal(podBucket(p), podPhaseBucket(p), name);
  });

  test('countPod fills every bucket', () => {
    const c = Object.values(PODS).reduce((acc, p) => countPod(acc, p), null);
    assert.deepEqual(Object.keys(c), POD_BUCKETS);
    assert.equal(Object.values(c).reduce((a, b) => a + b, 0), Object.keys(PODS).length);
  });
});

describe('workloadSummary', () => {
  test('deployments and statefulsets: ready, not ready, scaled to zero', () => {
    const dep = (replicas, available) => ({ spec: { replicas }, status: { availableReplicas: available } });
    assert.deepEqual(workloadSummary('deployments', [dep(3, 3), dep(2, 1), dep(0, 0), { spec: {}, status: {} }]), { total: 4, ready: 1, notReady: 2, scaledDown: 1 });
    const sts = (replicas, ready) => ({ spec: { replicas }, status: { readyReplicas: ready } });
    assert.deepEqual(workloadSummary('statefulSets', [sts(1, 1), sts(3, 2)]), { total: 2, ready: 1, notReady: 1 });
  });

  test('daemonsets, jobs, cronjobs, services', () => {
    assert.deepEqual(workloadSummary('daemonSets', [{ status: { desiredNumberScheduled: 3, numberReady: 3 } }, { status: { desiredNumberScheduled: 3, numberReady: 2 } }]), { total: 2, ready: 1, notReady: 1 });
    const job = (type) => ({ status: { conditions: type ? [{ type, status: 'True' }] : [] } });
    assert.deepEqual(workloadSummary('jobs', [job('Complete'), job('Failed'), job()]), { total: 3, complete: 1, failed: 1, active: 1 });
    assert.deepEqual(workloadSummary('cronJobs', [{ spec: { suspend: true } }, { spec: {} }]), { total: 2, suspended: 1, scheduled: 1 });
    assert.deepEqual(workloadSummary('services', [{}, {}]), { total: 2, ok: 2 });
    assert.deepEqual(workloadSummary('jobs', []), { total: 0 });
    assert.throws(() => workloadSummary('nope', []));
  });
});

describe('GET /api/cluster/summary (demo cluster)', () => {
  let srv;
  before(async () => {
    srv = await startServer();
    await srv.authed('/api/config/context', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contextName: 'demo-cluster' }) });
  });
  after(async () => { await srv?.stop(); });

  test('pods come with health buckets and the workloads with their counts', async () => {
    const s = await (await srv.authed('/api/cluster/summary')).json();
    assert.deepEqual(Object.keys(s.pods.buckets), POD_BUCKETS);
    assert.equal(Object.values(s.pods.buckets).reduce((a, b) => a + b, 0), s.pods.total);
    assert.deepEqual(Object.keys(s.workloads).sort(), [...WORKLOAD_KINDS].sort());
    for (const k of WORKLOAD_KINDS) assert.ok(Number.isInteger(s.workloads[k].total), k);
    assert.ok(s.workloads.deployments.total > 0);
  });
});
