// Cluster capacity: how much of what the nodes can run is reserved by the
// scheduler (requests), promised (limits) and actually used (metrics-server).
// Allocatable vs capacity alone is always ~100% and says nothing about room
// left. Requests follow `kubectl describe node` ("Allocated resources"): per
// pod, the larger of its app containers (plus native sidecars) and its biggest
// init container, plus the pod overhead; only pods bound to a node and not
// finished count. Shared by server.js and demo.js.

/** "250m" / "0.5" / "2" / "1500u" / "120000n" → millicores. */
export function parseCpuMilli(s) {
  if (s == null || s === '' || s === '-') return 0;
  const str = String(s).trim();
  const n = parseFloat(str);
  if (!Number.isFinite(n)) return 0;
  if (str.endsWith('n')) return n / 1e6;
  if (str.endsWith('u')) return n / 1e3;
  if (str.endsWith('m')) return n;
  return n * 1000;
}

const BIN = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
const DEC = { m: 1e-3, '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };

/** Kubernetes quantity → bytes: "512Mi", "1Gi", "128974848", "129M", "129e6". */
export function parseMemBytes(s) {
  if (s == null || s === '' || s === '-') return 0;
  const m = String(s).trim().match(/^([0-9.]+(?:e[0-9]+)?)\s*(Ki|Mi|Gi|Ti|Pi|Ei|m|k|K|M|G|T|P|E)?$/);
  if (!m) return parseFloat(s) || 0;
  const v = parseFloat(m[1]);
  const unit = m[2] || '';
  return v * (BIN[unit] ?? DEC[unit] ?? 1);
}

const zero = () => ({ cpu: 0, mem: 0 });
const add = (a, b) => ({ cpu: a.cpu + b.cpu, mem: a.mem + b.mem });
const max = (a, b) => ({ cpu: Math.max(a.cpu, b.cpu), mem: Math.max(a.mem, b.mem) });
const amounts = (list = {}) => ({ cpu: parseCpuMilli(list.cpu), mem: parseMemBytes(list.memory) });

/** What one pod reserves: { requests: { cpu, mem }, limits: { cpu, mem } } in millicores / bytes. */
export function podResources(pod) {
  const spec = pod?.spec || {};
  const out = {};
  for (const kind of ['requests', 'limits']) {
    let app = (spec.containers || []).reduce((acc, c) => add(acc, amounts(c.resources?.[kind])), zero());
    let sidecars = zero();
    let initMax = zero();
    for (const c of spec.initContainers || []) {
      let r = amounts(c.resources?.[kind]);
      if (c.restartPolicy === 'Always') {
        // A native sidecar keeps running alongside the later init containers and the app.
        sidecars = add(sidecars, r);
        r = sidecars;
      } else {
        r = add(r, sidecars);
      }
      initMax = max(initMax, r);
    }
    app = add(app, sidecars);
    out[kind] = add(max(app, initMax), amounts(spec.overhead));
  }
  return out;
}

/**
 * Running totals, fed node by node and page by page of pods:
 *   const t = capacityTotals(); nodes.forEach(t.addNode); pods.forEach(t.addPod); t.result()
 */
export function capacityTotals() {
  const t = {
    cpuAllocatableMilli: 0, memAllocatableBytes: 0, podsAllocatable: 0,
    cpuRequestedMilli: 0, memRequestedBytes: 0, cpuLimitsMilli: 0, memLimitsBytes: 0,
    podsScheduled: 0, podsUnscheduled: 0,
  };
  return {
    addNode(node) {
      const a = node?.status?.allocatable || {};
      t.cpuAllocatableMilli += parseCpuMilli(a.cpu);
      t.memAllocatableBytes += parseMemBytes(a.memory);
      t.podsAllocatable += parseInt(a.pods, 10) || 0;
    },
    addPod(pod) {
      const phase = pod?.status?.phase;
      if (phase === 'Succeeded' || phase === 'Failed') return;
      if (!pod?.spec?.nodeName) {
        // Waiting for a node with room (or for the scheduler).
        if (phase === 'Pending') t.podsUnscheduled += 1;
        return;
      }
      const r = podResources(pod);
      t.cpuRequestedMilli += r.requests.cpu;
      t.memRequestedBytes += r.requests.mem;
      t.cpuLimitsMilli += r.limits.cpu;
      t.memLimitsBytes += r.limits.mem;
      t.podsScheduled += 1;
    },
    result() {
      return {
        ...t,
        cpuAllocatableMilli: Math.round(t.cpuAllocatableMilli),
        cpuRequestedMilli: Math.round(t.cpuRequestedMilli),
        cpuLimitsMilli: Math.round(t.cpuLimitsMilli),
        memAllocatableBytes: Math.round(t.memAllocatableBytes),
        memRequestedBytes: Math.round(t.memRequestedBytes),
        memLimitsBytes: Math.round(t.memLimitsBytes),
      };
    },
  };
}

/** Node metrics (metrics.k8s.io NodeMetrics items) → { cpuMilli, memBytes } in use. */
export function nodeUsage(items) {
  let cpuMilli = 0;
  let memBytes = 0;
  for (const it of items || []) {
    cpuMilli += parseCpuMilli(it.usage?.cpu);
    memBytes += parseMemBytes(it.usage?.memory);
  }
  return { cpuMilli: Math.round(cpuMilli), memBytes: Math.round(memBytes) };
}
