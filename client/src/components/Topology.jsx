import { useEffect, useId, useMemo, useState } from 'react';
import Icon from './Icons';
import Loader from './Loader';
import useRequest from '../hooks/useRequest';
import { getJson, p } from '../lib/api';
import { KIND_ICON } from '../lib/kinds';
import { statusTone } from '../lib/status';
import { StatusDot } from './ui/Badge';
import Button from './ui/Button';
import ErrorState from './ui/ErrorState';
import DataTable from './ui/DataTable';
import EmptyState from './ui/EmptyState';
import { layoutGraph, edgePath } from './graph/layout';
import useGraphViewport, { GRAPH_KEY_HINT } from './graph/useGraphViewport';
import GraphControls from './graph/GraphControls';
import { errorTitle } from './shared/errors';

// Namespace topology: workloads → owners → pods → dependencies, laid out in
// columns by `graph/layout.js`. Colours come from the theme tokens through the
// category tone (data-tone / data-type attributes styled in App.css), never
// from hard-coded hex values.

const NODE_W = 190;
const NODE_H = 54;
const GAP_X = 90;
const GAP_Y = 22;

/** Node/edge category → tone. Workloads are blue (info), network yellow (warn),
 *  storage purple, config cyan, RBAC green. */
export const CATEGORY_TONE = { workload: 'info', network: 'warn', storage: 'purple', config: 'cyan', rbac: 'ok' };
const EDGE_TONE = { owns: 'muted', service: 'warn', network: 'warn', storage: 'purple', config: 'cyan', rbac: 'ok' };
const EDGE_TYPES = Object.keys(EDGE_TONE);

const CATEGORIES = [
  { key: 'network', label: 'Network' },
  { key: 'storage', label: 'Storage' },
  { key: 'config', label: 'Config' },
  { key: 'rbac', label: 'RBAC' },
];

const categoryOf = (n) => n.category || 'workload';

/** Only meaningful statuses get a dot (unknown / empty → nothing, as before). */
const nodeTone = (n) => {
  const s = (n.status || '').toLowerCase();
  if (!s || s === 'unknown') return null;
  return statusTone(n.kind, n.status);
};

export default function Topology({
  namespace: namespaceProp,
  namespaces = [],
  onNamespaceChange,
  refreshSignal = 0,
  onSelectResource,
}) {
  const realNamespaces = useMemo(() => namespaces.filter((n) => n !== 'all'), [namespaces]);
  // Controlled by the App shell when `namespace` is passed; otherwise local.
  const [localNs, setLocalNs] = useState('');
  const namespace = namespaceProp !== undefined && namespaceProp !== null ? namespaceProp : localNs;
  const setNamespace = (ns) => { setLocalNs(ns); onNamespaceChange?.(ns); };

  useEffect(() => {
    if (!namespace && realNamespaces.length) {
      const pick = realNamespaces.includes('default') ? 'default' : realNamespaces[0];
      setLocalNs(pick);
      onNamespaceChange?.(pick);
    }
  }, [realNamespaces, namespace, onNamespaceChange]);

  const { data, error, loading: fetching, refetching, refetch } = useRequest(
    ({ signal }) => getJson(p('api', 'topology', namespace), { signal }),
    { deps: [namespace, refreshSignal], enabled: !!namespace, dedupeKey: `topology:${namespace}` },
  );
  // Also covers the frame between picking a namespace and the request starting.
  const loading = fetching || (!!namespace && !data && !error);
  const nodes = useMemo(() => data?.nodes || [], [data]);
  const edges = useMemo(() => data?.edges || [], [data]);
  const partialError = data?.error || null;

  const [cats, setCats] = useState({ network: true, storage: true, config: true, rbac: true });
  const [listView, setListView] = useState(false);
  const vp = useGraphViewport({ initial: { x: 40, y: 40 } });
  const { reset: resetView } = vp;
  // New namespace → back to the origin (a refresh keeps the current pan/zoom).
  useEffect(() => { resetView(); }, [namespace, resetView]);

  const filtered = useMemo(() => {
    const kept = nodes.filter((n) => categoryOf(n) === 'workload' || cats[categoryOf(n)]);
    const ids = new Set(kept.map((n) => n.id));
    return { nodes: kept, edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
  }, [nodes, edges, cats]);

  const catCounts = useMemo(() => {
    const c = {};
    nodes.forEach((n) => { const k = categoryOf(n); c[k] = (c[k] || 0) + 1; });
    return c;
  }, [nodes]);

  const { positioned, links } = useMemo(
    () => layoutGraph({ nodes: filtered.nodes, edges: filtered.edges, nodeW: NODE_W, nodeH: NODE_H, gapX: GAP_X, gapY: GAP_Y }),
    [filtered],
  );

  const nsId = useId();
  const hintId = useId();
  const activate = (n) => onSelectResource?.({ kind: n.kind, name: n.name, namespace: n.namespace || namespace, status: n.status, category: categoryOf(n) });
  const onNodeKey = (e, n) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(n); } };

  const showError = !loading && ((error && nodes.length === 0) || (partialError && nodes.length === 0));
  const graphLabel = `Topology of namespace ${namespace}: ${positioned.length} resources, ${links.length} relationships`;

  return (
    <div className="topology-view">
      <div className="topology-header">
        <h1>
          <Icon name="topology" size={18} />
          Topology
        </h1>
        <div className="resource-controls">
          <label htmlFor={nsId} className="sr-only">Namespace</label>
          <select
            id={nsId}
            className="nav-context-selector topo-nssel"
            value={namespace}
            onChange={(e) => setNamespace(e.target.value)}
          >
            {realNamespaces.map((ns) => <option key={ns} value={ns}>{ns}</option>)}
          </select>
        </div>
      </div>

      <ul className="topo-filterbar" aria-label="Resource categories">
        <li className="topo-filter-label" aria-hidden="true">Show</li>
        <li>
          <span className="topo-filter-chip workload static">
            <span className="topo-legend-swatch" data-tone={CATEGORY_TONE.workload} aria-hidden="true" />
            Workloads<span className="topo-filter-count">{catCounts.workload || 0}</span>
          </span>
        </li>
        {CATEGORIES.map((c) => {
          const on = !!cats[c.key];
          return (
            <li key={c.key}>
              <button
                type="button"
                className={`topo-filter-chip ${on ? 'on' : 'off'}`}
                aria-pressed={on}
                onClick={() => setCats((prev) => ({ ...prev, [c.key]: !prev[c.key] }))}
              >
                <span className="topo-legend-swatch" data-tone={CATEGORY_TONE[c.key]} aria-hidden="true" />
                <span className="topo-filter-text">{c.label}</span>
                <span className="topo-filter-count">{catCounts[c.key] || 0}</span>
                {!on && <span className="sr-only"> (hidden)</span>}
              </button>
            </li>
          );
        })}
        <li className="topo-filter-spacer">
          <Button
            variant="ghost" size="sm" icon={listView ? 'topology' : 'details'}
            aria-pressed={listView}
            onClick={() => setListView((v) => !v)}
          >
            {listView ? 'Graph view' : 'List view'}
          </Button>
        </li>
      </ul>

      {listView ? (
        <div className="topo-list">
          {showError ? (
            <ErrorState error={error || partialError} title={errorTitle(error, `the topology of ${namespace}`)} onRetry={refetch} busy={refetching} />
          ) : (
            <DataTable
              caption={graphLabel}
              columns={[
                { key: 'kind', header: 'Kind', sortable: true, width: 170, render: (n) => (
                  <span className="resource-name-cell"><Icon name={KIND_ICON[n.kind] || 'box'} size={14} className="rn-icon" /><span className="rn-text">{n.kind}</span></span>
                ) },
                { key: 'name', header: 'Name', sortable: true, ellipsis: true, width: 320 },
                { key: 'category', header: 'Category', sortable: true, accessor: categoryOf, render: (n) => categoryOf(n) },
                { key: 'status', header: 'Status', sortable: true, render: (n) => (n.status ? <span className={`tone-${nodeTone(n) || 'muted'}`}>{n.status}</span> : '—') },
              ]}
              rows={filtered.nodes}
              rowKey={(n) => n.id}
              rowName={(n) => `${n.kind} ${n.name}`}
              onRowActivate={onSelectResource ? activate : undefined}
              loading={loading}
              refetching={refetching}
              emptyState={<EmptyState icon="topology" title="No resources in this namespace" />}
              initialSort={{ key: 'kind', dir: 'asc' }}
              storageKey="topology"
            />
          )}
        </div>
      ) : (
        <div
          className={`topology-canvas ${vp.dragging ? 'dragging' : ''}`}
          role="group"
          aria-label="Topology graph canvas"
          aria-describedby={hintId}
          {...vp.canvasProps}
        >
          <span id={hintId} className="sr-only">{GRAPH_KEY_HINT} Press Enter on a resource to open it.</span>
          {loading && <div className="topo-empty"><Loader label="Building topology…" /></div>}
          {showError && (
            <div className="topo-empty topo-error">
              <ErrorState error={error || partialError} title={errorTitle(error, `the topology of ${namespace}`)} onRetry={refetch} busy={refetching} />
            </div>
          )}
          {!loading && !showError && positioned.length === 0 && (
            <div className="topo-empty" role="status">No resources in this namespace</div>
          )}

          {!loading && positioned.length > 0 && (
            <svg role="img" aria-label={graphLabel}>
              <title>{graphLabel}</title>
              <defs>
                {EDGE_TYPES.map((type) => (
                  <marker key={type} id={`arrow-${type}`} viewBox="0 0 10 10" refX="9" refY="5"
                    markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" className="topo-arrow" data-tone={EDGE_TONE[type]} />
                  </marker>
                ))}
              </defs>
              <g transform={vp.transform}>
                {links.map((l) => (
                  <path
                    key={`${l.source}→${l.target}:${l.type}`}
                    className="topo-edge"
                    data-tone={EDGE_TONE[l.type] || 'muted'}
                    d={edgePath(l, NODE_W, NODE_H)}
                    strokeDasharray={l.type === 'owns' ? '' : '5 4'}
                    markerEnd={`url(#arrow-${l.type in EDGE_TONE ? l.type : 'owns'})`}
                  />
                ))}
                {positioned.map((n) => {
                  const tone = nodeTone(n);
                  return (
                    <foreignObject key={n.id} x={n.x} y={n.y} width={NODE_W} height={NODE_H}>
                      <div
                        className="topo-node-card"
                        role={onSelectResource ? 'button' : 'group'}
                        tabIndex={0}
                        aria-label={`${n.kind} ${n.name}${n.status ? `, status ${n.status}` : ''}`}
                        title={`${n.kind}: ${n.name}`}
                        onClick={onSelectResource ? () => activate(n) : undefined}
                        onKeyDown={onSelectResource ? (e) => onNodeKey(e, n) : undefined}
                      >
                        <div className="tn-icon" data-tone={CATEGORY_TONE[categoryOf(n)] || 'info'}>
                          <Icon name={KIND_ICON[n.kind] || 'box'} size={18} />
                        </div>
                        <div className="tn-body">
                          <span className="tn-name">{n.name}</span>
                          <span className="tn-kind">{n.kind}</span>
                        </div>
                        {tone && <StatusDot tone={tone} label={`Status: ${n.status}`} className="tn-status" />}
                      </div>
                    </foreignObject>
                  );
                })}
              </g>
            </svg>
          )}

          <GraphControls onZoomIn={vp.zoomIn} onZoomOut={vp.zoomOut} onReset={vp.reset} />
        </div>
      )}
    </div>
  );
}
