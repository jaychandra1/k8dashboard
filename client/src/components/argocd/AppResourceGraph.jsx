import { useEffect, useId, useMemo, useState } from 'react';
import Icon from '../Icons';
import { KIND_ICON, KIND_TYPE } from '../../lib/kinds';
import { statusClass } from '../../lib/status';
import Badge, { StatusDot } from '../ui/Badge';
import Button from '../ui/Button';
import DataTable from '../ui/DataTable';
import EmptyState from '../ui/EmptyState';
import { layoutGraph, bfsDepths, edgePath } from '../graph/layout';
import useGraphViewport, { GRAPH_KEY_HINT } from '../graph/useGraphViewport';
import GraphControls from '../graph/GraphControls';
import { healthTone, syncTone, shortKind, resourceKey } from './status';

// Argo CD-style "Application Details Tree": cards with a kind glyph, the short
// kind label, the resource name, a health heart and a sync dot, wired
// left→right from the Application root. Layout comes from graph/layout.js in
// 'tree' mode (one row per node, pre-order), the same engine Topology uses.
const NODE_W = 250; const NODE_H = 66; const GAP_X = 74; const GAP_Y = 18;
const ROOT = '__app__';

/** Nodes + parent edges from the app's resource list (ownerReference when the
 *  backend resolved it, name-prefix inference otherwise). */
export function buildAppTree(app, resources) {
  const nodes = [{ id: ROOT, kind: 'Application', name: app.name, namespace: app.namespace, sync: app.syncStatus, health: app.healthStatus, isApp: true }];
  const rs = resources.map((r) => ({ ...r, id: resourceKey(r) }));
  const ids = new Set(rs.map((x) => x.id));
  const byKind = (k) => rs.filter((x) => x.kind === k);
  const prefixParent = (nm, candidates) => candidates
    .filter((c) => nm === c.name || nm.startsWith(`${c.name}-`))
    .sort((a, b) => b.name.length - a.name.length)[0];
  const parentOf = (r) => {
    if (r.parentKey) return ids.has(r.parentKey) ? r.parentKey : ROOT;
    if (r.kind === 'Pod') return (prefixParent(r.name, byKind('ReplicaSet')) || prefixParent(r.name, [...byKind('StatefulSet'), ...byKind('DaemonSet'), ...byKind('Job')]))?.id || ROOT;
    if (r.kind === 'ReplicaSet') return prefixParent(r.name, byKind('Deployment'))?.id || ROOT;
    if (r.kind === 'Job') return prefixParent(r.name, byKind('CronJob'))?.id || ROOT;
    if (r.kind === 'Endpoints' || r.kind === 'EndpointSlice') return prefixParent(r.name, byKind('Service'))?.id || ROOT;
    return ROOT;
  };
  const edges = [];
  const seen = new Set();
  rs.forEach((r) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    nodes.push({ id: r.id, kind: r.kind, name: r.name, namespace: r.namespace, sync: r.syncStatus, health: r.healthStatus, msg: r.healthMessage });
    edges.push({ source: parentOf(r), target: r.id, type: 'owns' });
  });
  return { nodes, edges };
}

function nodeLabel(n) {
  return `${n.kind} ${n.namespace ? `${n.namespace}/` : ''}${n.name}${n.health ? `, health ${n.health}` : ''}${n.sync ? `, sync ${n.sync}` : ''}`;
}

export default function AppResourceGraph({ app, resources = [], onOpenResource }) {
  const [listView, setListView] = useState(false);
  const hintId = useId();
  const vp = useGraphViewport({ initial: { x: 40, y: 24 } });
  const { reset: fitView, setContent: setGraphSize } = vp;
  useEffect(() => { fitView(); }, [app.name, fitView]);

  const { positioned, links, width: graphW, height: graphH } = useMemo(() => {
    const { nodes, edges } = buildAppTree(app, resources);
    const depth = bfsDepths(ROOT, edges);
    return layoutGraph({
      nodes, edges, rankOf: (n) => depth.get(n.id) ?? 0, isTreeEdge: () => true,
      stack: 'tree', nodeW: NODE_W, nodeH: NODE_H, gapX: GAP_X, gapY: GAP_Y, minHeight: 200,
    });
  }, [app, resources]);
  useEffect(() => { setGraphSize({ width: graphW, height: graphH }); }, [graphW, graphH, setGraphSize]);

  const canOpen = (n) => !!onOpenResource && !n.isApp && !!KIND_TYPE[n.kind];
  const open = (n) => { if (canOpen(n)) onOpenResource(n); };
  const onNodeKey = (e, n) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(n); } };
  const graphLabel = `Resource graph for ${app.name}: ${Math.max(0, positioned.length - 1)} managed resources`;

  return (
    <div className="argo-graph">
      <div className="argo-graph-toolbar">
        <Button variant="ghost" size="sm" icon={listView ? 'topology' : 'details'} aria-pressed={listView} onClick={() => setListView((v) => !v)}>
          {listView ? 'Graph view' : 'List view'}
        </Button>
      </div>

      {listView ? (
        <div className="argo-graph-list">
          <DataTable
            caption={graphLabel}
            columns={[
              { key: 'kind', header: 'Kind', sortable: true, width: 170, render: (n) => (
                <span className="resource-name-cell"><Icon name={n.isApp ? 'argocd' : (KIND_ICON[n.kind] || 'box')} size={14} className="rn-icon" /><span className="rn-text">{n.kind}</span></span>
              ) },
              { key: 'name', header: 'Name', sortable: true, ellipsis: true, width: 300 },
              { key: 'namespace', header: 'Namespace', sortable: true, render: (n) => n.namespace || '—' },
              { key: 'sync', header: 'Sync', sortable: true, render: (n) => (n.sync ? <Badge tone={syncTone(n.sync)} size="sm">{n.sync}</Badge> : '—') },
              { key: 'health', header: 'Health', sortable: true, render: (n) => (n.health ? <Badge tone={healthTone(n.health)} size="sm">{n.health}</Badge> : '—') },
            ]}
            rows={positioned}
            rowKey={(n) => n.id}
            rowName={(n) => `${n.kind} ${n.name}`}
            onRowActivate={onOpenResource ? open : undefined}
            emptyState={<EmptyState icon="argocd" title="This application reports no managed resources." />}
            storageKey="argocd-graph"
          />
        </div>
      ) : (
        <div
          ref={vp.canvasRef}
          className={`topology-canvas argo-tree-canvas ${vp.dragging ? 'dragging' : ''}`}
          role="group"
          aria-label={`Resource graph canvas for ${app.name}`}
          aria-describedby={hintId}
          {...vp.canvasProps}
        >
          <span id={hintId} className="sr-only">{GRAPH_KEY_HINT} Press Enter on a resource to open it in the cluster view.</span>
          {positioned.length <= 1 && (
            <div className="topo-empty" role="status">This application reports no managed resources.</div>
          )}
          <svg role="img" aria-label={graphLabel}>
            <title>{graphLabel}</title>
            <g transform={vp.transform}>
              {links.map((l) => (
                <path key={`${l.source}→${l.target}`} className="argo-tree-edge" d={edgePath(l, NODE_W, NODE_H, 24)} />
              ))}
              {positioned.map((n) => {
                const ht = n.health ? healthTone(n.health) : null;
                const openable = canOpen(n);
                return (
                  <foreignObject key={n.id} x={n.x} y={n.y} width={NODE_W} height={NODE_H}>
                    <div
                      className={`argo-gnode ${n.isApp ? 'is-app' : ''} ${openable ? 'openable' : ''}`}
                      role={openable ? 'button' : 'group'}
                      tabIndex={0}
                      aria-label={nodeLabel(n)}
                      title={`${n.kind}: ${n.namespace ? `${n.namespace}/` : ''}${n.name}${n.health ? `\nHealth: ${n.health}` : ''}${n.sync ? `\nSync: ${n.sync}` : ''}${n.msg ? `\n${n.msg}` : ''}`}
                      onClick={() => open(n)}
                      onKeyDown={(e) => onNodeKey(e, n)}
                    >
                      <div className="argo-gnode-kind">
                        <span className="argo-gnode-glyph" data-kind={n.isApp ? 'Application' : n.kind}>
                          <Icon name={n.isApp ? 'argocd' : (KIND_ICON[n.kind] || 'box')} size={21} />
                        </span>
                        <span className="argo-gnode-klabel">{shortKind(n.kind)}</span>
                      </div>
                      <div className="argo-gnode-main">
                        <span className="argo-gnode-name">{n.name}</span>
                        <span className="argo-gnode-status">
                          {ht && (
                            <span className={`argo-gnode-heart ${statusClass(ht)}`}>
                              <Icon name="heart" size={13} title={`Health: ${n.health}`} style={{ fill: 'currentColor' }} />
                            </span>
                          )}
                          <StatusDot tone={syncTone(n.sync)} label={`Sync: ${n.sync || 'n/a'}`} className="argo-gnode-syncdot" />
                        </span>
                      </div>
                      <span className="argo-gnode-menu" aria-hidden="true"><Icon name="more" size={15} /></span>
                    </div>
                  </foreignObject>
                );
              })}
            </g>
          </svg>

          <GraphControls onZoomIn={vp.zoomIn} onZoomOut={vp.zoomOut} onReset={vp.reset} resetLabel="Fit / reset view" />
        </div>
      )}
    </div>
  );
}

export { AppResourceGraph };
