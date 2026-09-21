// Pure layered-graph layout shared by Topology and the Argo CD application
// graph. No React, no DOM — unit-tested in layout.test.js.
//
//   const { positioned, links, width, height } = layoutGraph({
//     nodes: [{ id, kind, name, … }], edges: [{ source, target, type }],
//     rankOf: (node) => 0..n,          // column index (defaults to DEFAULT_RANK by kind)
//     isTreeEdge: (e) => e.type === 'owns',
//     nodeW, nodeH, gapX, gapY,
//     stack: 'column' | 'tree',        // 'tree': one row per node in pre-order (file-tree look)
//     pullFromRank: 3,                 // 'column' only: ranks ≥ this are pulled toward their sources
//   });

/** Default column per Kubernetes kind: workloads → owners → pods → dependencies. */
export const DEFAULT_RANK = {
  CronJob: 0, Deployment: 0, StatefulSet: 0, DaemonSet: 0,
  ReplicaSet: 1, Job: 1,
  Pod: 2,
  Service: 3, PersistentVolumeClaim: 3, ConfigMap: 3, Secret: 3, ServiceAccount: 3, NetworkPolicy: 3,
  Ingress: 4, PersistentVolume: 4, RoleBinding: 4,
  StorageClass: 5, Role: 5, ClusterRole: 5,
};

export const defaultRankOf = (n) => DEFAULT_RANK[n.kind] ?? 2;

const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || '')) || String(a.id).localeCompare(String(b.id));

export function layoutGraph({
  nodes = [],
  edges = [],
  rankOf = defaultRankOf,
  isTreeEdge = (e) => e.type === 'owns',
  nodeW = 190,
  nodeH = 54,
  gapX = 90,
  gapY = 22,
  stack = 'column',
  pullFromRank = 3,
  minWidth = 400,
  minHeight = 300,
} = {}) {
  if (!nodes.length) return { positioned: [], links: [], width: 0, height: 0 };

  const byId = new Map(nodes.map((n) => [n.id, { ...n, rank: rankOf(n) }]));
  const children = new Map();
  const hasParent = new Set();
  edges.filter(isTreeEdge).forEach((e) => {
    if (!byId.has(e.source) || !byId.has(e.target)) return;
    if (!children.has(e.source)) children.set(e.source, []);
    children.get(e.source).push(e.target);
    hasParent.add(e.target);
  });

  // Pre-order DFS from the roots (rank 0 without a parent), then any leftovers,
  // so related nodes cluster together and each column keeps its tree order.
  const order = new Map();
  let seq = 0;
  const visit = (id) => {
    if (order.has(id) || !byId.has(id)) return;
    order.set(id, seq++);
    (children.get(id) || [])
      .map((cid) => byId.get(cid))
      .filter(Boolean)
      .sort(byName)
      .forEach((c) => visit(c.id));
  };
  [...byId.values()].filter((n) => n.rank === 0 && !hasParent.has(n.id)).sort(byName).forEach((n) => visit(n.id));
  [...byId.values()].sort(byName).forEach((n) => visit(n.id));

  const ranks = new Map();
  byId.forEach((n) => { if (!ranks.has(n.rank)) ranks.set(n.rank, []); ranks.get(n.rank).push(n); });
  const rankKeys = [...ranks.keys()].sort((a, b) => a - b);
  rankKeys.forEach((r) => ranks.get(r).sort((a, b) => order.get(a.id) - order.get(b.id)));

  const pos = new Map();
  rankKeys.forEach((rank) => {
    ranks.get(rank).forEach((n, i) => {
      const row = stack === 'tree' ? order.get(n.id) : i;
      pos.set(n.id, { ...n, x: rank * (nodeW + gapX), y: row * (nodeH + gapY) });
    });
  });

  if (stack !== 'tree') {
    // Pull dependency columns toward the average Y of whatever points at them,
    // then de-overlap within the column.
    const incoming = new Map();
    edges.forEach((e) => {
      if (!pos.has(e.source) || !pos.has(e.target)) return;
      if (!incoming.has(e.target)) incoming.set(e.target, []);
      incoming.get(e.target).push(e.source);
    });
    rankKeys.filter((r) => r >= pullFromRank).forEach((rank) => {
      ranks.get(rank).forEach((n) => {
        const ys = (incoming.get(n.id) || []).map((s) => pos.get(s)?.y).filter((v) => v != null);
        if (ys.length) pos.get(n.id).y = ys.reduce((a, b) => a + b, 0) / ys.length;
      });
      const col = ranks.get(rank).map((n) => pos.get(n.id)).sort((a, b) => a.y - b.y);
      for (let i = 1; i < col.length; i++) {
        const minY = col[i - 1].y + nodeH + gapY;
        if (col[i].y < minY) col[i].y = minY;
      }
    });
  }

  const positioned = [...pos.values()];
  const links = edges
    .map((e) => {
      const s = pos.get(e.source);
      const t = pos.get(e.target);
      return s && t ? { ...e, s, t } : null;
    })
    .filter(Boolean);
  const width = Math.max(...positioned.map((n) => n.x + nodeW), minWidth);
  const height = Math.max(...positioned.map((n) => n.y + nodeH), minHeight);
  return { positioned, links, width, height };
}

/** BFS depth of every node reachable from `rootId` (root = 0). Unreachable nodes are absent. */
export function bfsDepths(rootId, edges) {
  const kids = new Map();
  edges.forEach((e) => { if (!kids.has(e.source)) kids.set(e.source, []); kids.get(e.source).push(e.target); });
  const depth = new Map([[rootId, 0]]);
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift();
    (kids.get(id) || []).forEach((c) => {
      if (!depth.has(c)) { depth.set(c, depth.get(id) + 1); queue.push(c); }
    });
  }
  return depth;
}

/** Cubic bezier from the right edge of `link.s` to the left edge of `link.t`. */
export function edgePath(link, nodeW, nodeH, minDx = 30) {
  const sx = link.s.x + nodeW;
  const sy = link.s.y + nodeH / 2;
  const tx = link.t.x;
  const ty = link.t.y + nodeH / 2;
  const dx = Math.max(minDx, (tx - sx) * 0.5);
  return `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
}
