import { describe, it, expect } from 'vitest';
import { layoutGraph, bfsDepths, edgePath, DEFAULT_RANK } from './layout';

const W = 100; const H = 20; const GX = 10; const GY = 5;

const nodes = [
  { id: 'deploy/web', kind: 'Deployment', name: 'web' },
  { id: 'deploy/api', kind: 'Deployment', name: 'api' },
  { id: 'rs/web-1', kind: 'ReplicaSet', name: 'web-1' },
  { id: 'pod/web-1-a', kind: 'Pod', name: 'web-1-a' },
  { id: 'pod/web-1-b', kind: 'Pod', name: 'web-1-b' },
  { id: 'svc/web', kind: 'Service', name: 'web' },
  { id: 'cm/shared', kind: 'ConfigMap', name: 'shared' },
];
const edges = [
  { source: 'deploy/web', target: 'rs/web-1', type: 'owns' },
  { source: 'rs/web-1', target: 'pod/web-1-b', type: 'owns' },
  { source: 'rs/web-1', target: 'pod/web-1-a', type: 'owns' },
  { source: 'svc/web', target: 'pod/web-1-a', type: 'service' },
  { source: 'deploy/web', target: 'cm/shared', type: 'config' },
  { source: 'deploy/api', target: 'cm/shared', type: 'config' },
  { source: 'ghost', target: 'pod/web-1-a', type: 'owns' }, // dangling edge is ignored
];

describe('layoutGraph', () => {
  it('returns an empty layout for no nodes', () => {
    expect(layoutGraph({ nodes: [], edges: [] })).toEqual({ positioned: [], links: [], width: 0, height: 0 });
  });

  it('places nodes in columns by rank and keeps tree order within a column', () => {
    const { positioned, links, width, height } = layoutGraph({ nodes, edges, nodeW: W, nodeH: H, gapX: GX, gapY: GY });
    const at = (id) => positioned.find((n) => n.id === id);
    expect(at('deploy/web').x).toBe(0);
    expect(at('rs/web-1').x).toBe(1 * (W + GX));
    expect(at('pod/web-1-a').x).toBe(2 * (W + GX));
    expect(at('svc/web').x).toBe(DEFAULT_RANK.Service * (W + GX));
    // roots sorted by name: api before web
    expect(at('deploy/api').y).toBeLessThan(at('deploy/web').y);
    // children sorted by name under their owner
    expect(at('pod/web-1-a').y).toBeLessThan(at('pod/web-1-b').y);
    // dangling edge dropped, the rest resolved with positions
    expect(links).toHaveLength(edges.length - 1);
    links.forEach((l) => { expect(l.s).toBeDefined(); expect(l.t).toBeDefined(); });
    expect(width).toBeGreaterThanOrEqual(at('svc/web').x + W);
    expect(height).toBeGreaterThanOrEqual(H);
  });

  it('never overlaps nodes within a pulled column', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `cm/${i}`, kind: 'ConfigMap', name: `cm-${i}` }));
    const pulled = many.map((n) => ({ source: 'deploy/web', target: n.id, type: 'config' }));
    const { positioned } = layoutGraph({ nodes: [...nodes, ...many], edges: [...edges, ...pulled], nodeW: W, nodeH: H, gapX: GX, gapY: GY });
    const col = positioned.filter((n) => n.kind === 'ConfigMap').sort((a, b) => a.y - b.y);
    for (let i = 1; i < col.length; i++) expect(col[i].y - col[i - 1].y).toBeGreaterThanOrEqual(H + GY);
  });

  it('tree stacking gives every node its own row in pre-order', () => {
    const treeNodes = [
      { id: 'app', kind: 'Application', name: 'app' },
      { id: 'd', kind: 'Deployment', name: 'd' },
      { id: 'rs', kind: 'ReplicaSet', name: 'rs' },
      { id: 'svc', kind: 'Service', name: 'svc' },
    ];
    const treeEdges = [
      { source: 'app', target: 'd' }, { source: 'd', target: 'rs' }, { source: 'app', target: 'svc' },
    ];
    const depth = bfsDepths('app', treeEdges);
    const { positioned } = layoutGraph({
      nodes: treeNodes, edges: treeEdges, rankOf: (n) => depth.get(n.id) ?? 0, isTreeEdge: () => true,
      stack: 'tree', nodeW: W, nodeH: H, gapX: GX, gapY: GY,
    });
    const at = (id) => positioned.find((n) => n.id === id);
    expect(at('app')).toMatchObject({ x: 0, y: 0 });
    expect(at('d')).toMatchObject({ x: W + GX, y: 1 * (H + GY) });
    expect(at('rs')).toMatchObject({ x: 2 * (W + GX), y: 2 * (H + GY) });
    expect(at('svc')).toMatchObject({ x: W + GX, y: 3 * (H + GY) });
    const ys = positioned.map((n) => n.y);
    expect(new Set(ys).size).toBe(ys.length);
  });
});

describe('bfsDepths / edgePath', () => {
  it('computes depths from the root and ignores unreachable nodes', () => {
    const d = bfsDepths('a', [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }, { source: 'x', target: 'y' }]);
    expect(d.get('a')).toBe(0); expect(d.get('b')).toBe(1); expect(d.get('c')).toBe(2); expect(d.has('y')).toBe(false);
  });
  it('builds a bezier between node edges', () => {
    const path = edgePath({ s: { x: 0, y: 0 }, t: { x: 200, y: 100 } }, 100, 20, 30);
    expect(path).toBe('M 100 10 C 150 10, 150 110, 200 110');
  });
});
