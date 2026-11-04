// Cluster capacity (lib/capacity.mjs): requests / limits of the scheduled pods
// against the nodes' allocatable, the way `kubectl describe node` adds them up,
// and the summary route that reports it (demo mode).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseCpuMilli, parseMemBytes, podResources, capacityTotals, nodeUsage } from '../lib/capacity.mjs';
import { startServer } from './helpers/server.mjs';

const Mi = 2 ** 20;
const c = (name, requests, limits) => ({ name, resources: { requests, limits } });

describe('quantities', () => {
  test('cpu → millicores, memory → bytes', () => {
    assert.deepEqual(['250m', '0.5', '2', '1500u', '120000000n', '', '-', null].map(parseCpuMilli), [250, 500, 2000, 1.5, 120, 0, 0, 0]);
    assert.equal(parseMemBytes('512Mi'), 512 * Mi);
    assert.equal(parseMemBytes('1Gi'), 2 ** 30);
    assert.equal(parseMemBytes('129M'), 129e6);
    assert.equal(parseMemBytes('129e6'), 129e6);
    assert.equal(parseMemBytes('128974848'), 128974848);
    assert.equal(parseMemBytes('64k'), 64000);
  });
});

describe('what one pod reserves', () => {
  test('app containers add up; the biggest init container wins when larger; overhead is added', () => {
    const r = podResources({ spec: {
      containers: [c('app', { cpu: '100m', memory: '128Mi' }, { cpu: '500m', memory: '256Mi' }), c('log', { cpu: '50m', memory: '32Mi' })],
      initContainers: [c('migrate', { cpu: '1', memory: '64Mi' })],
      overhead: { cpu: '10m', memory: '8Mi' },
    } });
    assert.deepEqual(r.requests, { cpu: 1000 + 10, mem: (160 + 8) * Mi });
    assert.deepEqual(r.limits, { cpu: 500 + 10, mem: (256 + 8) * Mi });
  });

  test('a native sidecar (restartPolicy: Always) runs alongside the app and the later init containers', () => {
    const r = podResources({ spec: {
      initContainers: [{ ...c('proxy', { cpu: '100m', memory: '64Mi' }), restartPolicy: 'Always' }, c('migrate', { cpu: '300m', memory: '16Mi' })],
      containers: [c('app', { cpu: '200m', memory: '128Mi' })],
    } });
    // app + sidecar = 300m / 192Mi; migrate + sidecar = 400m / 80Mi → max per resource.
    assert.deepEqual(r.requests, { cpu: 400, mem: 192 * Mi });
  });
});

describe('cluster totals', () => {
  test('scheduled, unfinished pods count; pending ones waiting for a node are counted apart', () => {
    const t = capacityTotals();
    t.addNode({ status: { allocatable: { cpu: '3920m', memory: '15Gi', pods: '110' } } });
    t.addNode({ status: { allocatable: { cpu: '4', memory: '16Gi', pods: '110' } } });
    const pod = (phase, nodeName, cpu = '500m') => ({ spec: { nodeName, containers: [c('a', { cpu, memory: '256Mi' }, { cpu: '1', memory: '512Mi' })] }, status: { phase } });
    [pod('Running', 'n1'), pod('Running', 'n2'), pod('Pending', 'n1'), pod('Succeeded', 'n1'), pod('Failed', 'n2'), pod('Pending', undefined, '8')].forEach(t.addPod);
    assert.deepEqual(t.result(), {
      cpuAllocatableMilli: 7920, memAllocatableBytes: 31 * 2 ** 30, podsAllocatable: 220,
      cpuRequestedMilli: 1500, memRequestedBytes: 768 * Mi, cpuLimitsMilli: 3000, memLimitsBytes: 1536 * Mi,
      podsScheduled: 3, podsUnscheduled: 1,
    });
  });

  test('node usage from metrics-server', () => {
    assert.deepEqual(nodeUsage([{ usage: { cpu: '850000000n', memory: '5Gi' } }, { usage: { cpu: '1650m', memory: '8000Mi' } }]), { cpuMilli: 2500, memBytes: 5 * 2 ** 30 + 8000 * Mi });
  });
});

describe('GET /api/cluster/summary (demo cluster)', () => {
  let srv;
  before(async () => { srv = await startServer({ env: { KUBEPILOT_DEMO: '1' } }); });
  after(async () => { await srv?.stop(); });

  test('capacity has requests, limits, pod slots and usage next to allocatable', async () => {
    await srv.authed('/api/config/context', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contextName: 'demo-cluster' }) });
    const { capacity: cap } = await (await srv.authed('/api/cluster/summary')).json();
    assert.ok(cap.cpuAllocatableMilli > 0 && cap.memAllocatableBytes > 0 && cap.podsAllocatable > 0, JSON.stringify(cap));
    assert.ok(cap.cpuRequestedMilli > 0 && cap.cpuRequestedMilli < cap.cpuAllocatableMilli);
    assert.ok(cap.memRequestedBytes > 0 && cap.cpuLimitsMilli >= cap.cpuRequestedMilli);
    assert.ok(cap.podsScheduled > 0 && cap.podsScheduled <= cap.podsAllocatable);
    assert.equal(cap.podsUnscheduled, 1, 'the payments pod asks for 8 cores and can never be scheduled');
    assert.equal(cap.usage.available, true);
    assert.ok(cap.usage.cpuMilli > 0 && cap.usage.memBytes > 0);
  });
});
