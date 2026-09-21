import { useEffect, useId, useMemo, useState } from 'react';
import Icon from './Icons';
import MetricsChart from './MetricsChart';
import DataTable from './ui/DataTable';
import Badge from './ui/Badge';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import ErrorState from './ui/ErrorState';
import useRequest from '../hooks/useRequest';
import useDocumentTitle from '../hooks/useDocumentTitle';
import { getJson, p } from '../lib/api';
import { formatAge, fmtMem, fmtCpu, parseQuantity, pluralize } from '../lib/format';
import { statusTone } from '../lib/status';
import { XLink, nsLink, resourceLink, navigateVia } from './resources/links';

const fmtQty = (q) => { const b = parseQuantity(q); return Number.isNaN(b) ? (q && q !== '-' ? q : '—') : fmtMem(b); };
const fmtCpuCores = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} cores` : fmtCpu(m));
const fmtGi = (gi) => `${gi.toFixed(1)} Gi`;

const TABS = [
  { key: 'details', label: 'Details', icon: 'details' },
  { key: 'pods', label: 'Pods', icon: 'pod' },
];

export default function Nodes({ onSelectPod, focusNode, onFocusHandled, refreshSignal = 0, onNavigate }) {
  useDocumentTitle('Nodes');
  const uid = useId();
  const [selectedName, setSelectedName] = useState(null);
  const [activeTab, setActiveTab] = useState('details');

  const { data, error, loading, refetching, refetch } = useRequest(
    ({ signal }) => getJson(p('api', 'nodes'), { signal }),
    { deps: [refreshSignal], dedupeKey: 'nodes' },
  );
  const nodes = useMemo(() => data?.nodes || [], [data]);
  const selectedNode = selectedName ? nodes.find((n) => n.name === selectedName) || null : null;

  // Auto-select a node when navigated here via a cross-link
  useEffect(() => {
    if (!focusNode || !nodes.length) return;
    if (nodes.some((n) => n.name === focusNode)) { setSelectedName(focusNode); setActiveTab('details'); }
    onFocusHandled?.();
  }, [focusNode, nodes, onFocusHandled]);

  // Live node metrics for the detail graphs (3 s, paused while hidden)
  const [cpuHist, setCpuHist] = useState([]);
  const [memHist, setMemHist] = useState([]);
  useEffect(() => { setCpuHist([]); setMemHist([]); }, [selectedName]);
  const metrics = useRequest(
    ({ signal }) => getJson(p('api', 'metrics', 'node', selectedName), { signal }),
    {
      deps: [selectedName],
      enabled: !!selectedName,
      pollMs: 3000,
      onSuccess: (m) => {
        if (!m || m.available === false) return;
        setCpuHist((h) => [...h, m.cpuMilli].slice(-40));
        setMemHist((h) => [...h, m.memBytes].slice(-40));
      },
    },
  );
  const metricsAvail = !metrics.error && metrics.data?.available !== false;

  // Pods scheduled on the selected node
  const pods = useRequest(
    ({ signal }) => getJson(p('api', 'nodes', selectedName, 'pods'), { signal }),
    { deps: [selectedName, refreshSignal], enabled: !!selectedName && activeTab === 'pods', dedupeKey: `node-pods:${selectedName}` },
  );
  const nodePods = pods.data?.pods || [];

  const openPod = (pod) => {
    if (onSelectPod) onSelectPod(pod);
    else navigateVia(onNavigate, resourceLink('pod', pod.namespace, pod.name));
  };

  const nodeColumns = useMemo(() => [
    { key: 'name', header: 'Name', sortable: true, ellipsis: true, width: 260, render: (n) => <span className="resource-name-cell"><Icon name="nodes" size={15} className="rn-icon" /><span className="rn-text">{n.name}</span></span>, title: (n) => n.name },
    { key: 'status', header: 'Status', sortable: true, width: 120, render: (n) => <Badge status={n.status} kind="node" /> },
    { key: 'roles', header: 'Roles', sortable: true, width: 140, render: (n) => n.roles || '—' },
    { key: 'version', header: 'Version', sortable: true, mono: true, width: 130, render: (n) => n.version || '—' },
    { key: 'internalIp', header: 'Internal IP', sortable: true, mono: true, width: 140, render: (n) => n.internalIp || '—' },
    { key: 'cpuCapacity', header: 'CPU', sortable: true, align: 'right', mono: true, width: 80, accessor: (n) => parseQuantity(n.cpuCapacity) || 0, render: (n) => n.cpuCapacity || '—' },
    { key: 'memoryCapacity', header: 'Memory', sortable: true, align: 'right', mono: true, width: 100, accessor: (n) => parseQuantity(n.memoryCapacity) || 0, render: (n) => fmtQty(n.memoryCapacity) },
    { key: 'age', header: 'Age', sortable: true, align: 'right', mono: true, width: 80, accessor: (n) => (n.createdAt ? Date.parse(n.createdAt) : null), render: (n) => formatAge(n.createdAt) },
  ], []);

  const podColumns = useMemo(() => [
    {
      key: 'name', header: 'Name', sortable: true, ellipsis: true, width: 300,
      render: (pod) => (
        <XLink className="xlink resource-name-cell" link={resourceLink('pod', pod.namespace, pod.name)} onNavigate={onSelectPod ? () => onSelectPod(pod) : onNavigate} title={`Open pod ${pod.name}`}>
          <Icon name="pod" size={15} className="rn-icon" /><span className="rn-text">{pod.name}</span>
        </XLink>
      ),
      title: (pod) => pod.name,
    },
    { key: 'namespace', header: 'Namespace', sortable: true, ellipsis: true, width: 170, render: (pod) => <XLink link={nsLink(pod.namespace)} onNavigate={onNavigate} title={`Filter to ${pod.namespace}`}>{pod.namespace}</XLink>, title: (pod) => pod.namespace },
    { key: 'ready', header: 'Ready', sortable: true, mono: true, width: 80, render: (pod) => pod.ready || '—' },
    { key: 'status', header: 'Status', sortable: true, width: 140, render: (pod) => <Badge status={pod.status} kind="pod" /> },
    { key: 'restarts', header: 'Restarts', sortable: true, align: 'right', mono: true, width: 90, accessor: (pod) => pod.restarts ?? 0, render: (pod) => pod.restarts ?? 0 },
    { key: 'age', header: 'Age', sortable: true, align: 'right', mono: true, width: 80, accessor: (pod) => (pod.createdAt ? Date.parse(pod.createdAt) : null), render: (pod) => formatAge(pod.createdAt) },
  ], [onSelectPod, onNavigate]);

  const selectNode = (node, tab = 'details') => { setSelectedName(node.name); setActiveTab(tab); };
  const onTabKey = (e, idx) => {
    let next = null;
    if (e.key === 'ArrowRight') next = (idx + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next == null) return;
    e.preventDefault();
    setActiveTab(TABS[next].key);
    e.currentTarget.parentElement?.querySelector(`[data-tab="${TABS[next].key}"]`)?.focus();
  };

  return (
    <div className="resource-viewer">
      <div className="resource-header">
        <div>
          <h1 className="resource-title">
            <Icon name="nodes" size={18} />
            Nodes
          </h1>
          <span className="resource-count">{nodes.length} {pluralize(nodes.length, 'item')}</span>
          <span className="resource-refreshing" aria-live="polite" role="status">{refetching ? 'Refreshing…' : ''}</span>
        </div>
        <div className="resource-controls" />
      </div>

      <div className="resource-table-wrapper">
        {error && nodes.length === 0 ? (
          <ErrorState error={error} title="Couldn't load nodes" onRetry={refetch} busy={refetching} />
        ) : (
          <>
            {error && <ErrorState compact error={error} title="Latest refresh failed — showing previous nodes" onRetry={refetch} busy={refetching} />}
            <DataTable
              caption="Nodes"
              columns={nodeColumns}
              rows={nodes}
              rowKey={(n) => n.name}
              rowName={(n) => n.name}
              activeKey={selectedName}
              onRowActivate={(n) => selectNode(n)}
              rowActions={(n) => [
                { icon: 'details', label: 'Details', onSelect: () => selectNode(n, 'details') },
                { icon: 'pod', label: 'Pods on node', onSelect: () => selectNode(n, 'pods') },
              ]}
              getRowTone={(n) => (statusTone('node', n.status) === 'bad' ? 'bad' : undefined)}
              loading={loading}
              refetching={refetching}
              emptyState={<EmptyState icon="nodes" title="No nodes found" hint="The cluster reported no nodes." />}
              initialSort={{ key: 'name', dir: 'asc' }}
              storageKey="nodes"
            />
          </>
        )}
      </div>

      {selectedNode && (
        <section className="bottom-panel" role="region" aria-label={`Node ${selectedNode.name} details`}>
          <div className="bottom-panel-tabs" role="tablist" aria-label={`${selectedNode.name} panels`}>
            {TABS.map((t, idx) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                id={`${uid}-tab-${t.key}`}
                data-tab={t.key}
                aria-selected={activeTab === t.key}
                aria-controls={`${uid}-panel`}
                tabIndex={activeTab === t.key ? 0 : -1}
                className={`bottom-tab${activeTab === t.key ? ' active' : ''}`}
                onClick={() => setActiveTab(t.key)}
                onKeyDown={(e) => onTabKey(e, idx)}
              >
                <Icon name={t.icon} size={15} /> {t.label}
              </button>
            ))}
            <Button variant="ghost" size="sm" iconOnly icon="close" ariaLabel={`Close ${selectedNode.name} details`} className="bottom-panel-toggle" onClick={() => setSelectedName(null)} />
          </div>
          <div className="bottom-panel-content" id={`${uid}-panel`} role="tabpanel" aria-labelledby={`${uid}-tab-${activeTab}`}>
            {activeTab === 'details' && (
              <div className="details-tab-content">
                <div className="cluster-info-container node-info-grid">
                  <section className="cluster-info-card node-usage-card" aria-label="Resource usage">
                    <h3><Icon name="activity" size={15} /> Resource Usage</h3>
                    {!metricsAvail ? (
                      <div className="drawer-dim">Metrics not available</div>
                    ) : (
                      <div className="metric-charts metric-charts-row">
                        <div className="metric-chart-col">
                          <MetricsChart id={`${uid}-node-cpu`} label="CPU" data={cpuHist} limit={metrics.data?.cpuCapacityMilli} thresholdLabel="capacity" format={fmtCpuCores} tone="info" />
                        </div>
                        <div className="metric-chart-col">
                          <MetricsChart id={`${uid}-node-mem`} label="Memory" data={memHist.map((b) => b / 1024 ** 3)} limit={metrics.data?.memCapacityBytes ? metrics.data.memCapacityBytes / 1024 ** 3 : null} thresholdLabel="capacity" format={fmtGi} tone="purple" />
                        </div>
                      </div>
                    )}
                  </section>
                  <section className="cluster-info-card" aria-label="Node info">
                    <h3><Icon name="nodes" size={15} /> Node Info</h3>
                    <div className="info-item"><label>Name:</label><span className="context-value">{selectedNode.name}</span></div>
                    <div className="info-item"><label>Status:</label><span className="context-value"><Badge status={selectedNode.status} kind="node" /></span></div>
                    <div className="info-item"><label>Roles:</label><span className="context-value">{selectedNode.roles}</span></div>
                    <div className="info-item"><label>Unschedulable:</label><span className="context-value">{selectedNode.unschedulable ? 'Yes' : 'No'}</span></div>
                    <div className="info-item"><label>Taints:</label><span className="context-value">{selectedNode.taints}</span></div>
                  </section>
                  <section className="cluster-info-card" aria-label="System">
                    <h3><Icon name="box" size={15} /> System</h3>
                    <div className="info-item"><label>Kubelet Version:</label><span className="context-value">{selectedNode.version}</span></div>
                    <div className="info-item"><label>OS Image:</label><span className="context-value">{selectedNode.os}</span></div>
                    <div className="info-item"><label>Kernel Version:</label><span className="context-value">{selectedNode.kernelVersion}</span></div>
                    <div className="info-item"><label>Container Runtime:</label><span className="context-value">{selectedNode.containerRuntime}</span></div>
                  </section>
                  <section className="cluster-info-card" aria-label="Network">
                    <h3><Icon name="service" size={15} /> Network</h3>
                    <div className="info-item"><label>Internal IP:</label><span className="context-value">{selectedNode.internalIp}</span></div>
                    <div className="info-item"><label>External IP:</label><span className="context-value">{selectedNode.externalIp}</span></div>
                  </section>
                  <section className="cluster-info-card" aria-label="Resources">
                    <h3><Icon name="overview" size={15} /> Resources</h3>
                    <div className="info-item"><label>CPU Capacity:</label><span className="context-value">{selectedNode.cpuCapacity}</span></div>
                    <div className="info-item"><label>CPU Allocatable:</label><span className="context-value">{selectedNode.cpuAllocatable}</span></div>
                    <div className="info-item"><label>Memory Capacity:</label><span className="context-value">{fmtQty(selectedNode.memoryCapacity)}</span></div>
                    <div className="info-item"><label>Memory Allocatable:</label><span className="context-value">{fmtQty(selectedNode.memoryAllocatable)}</span></div>
                  </section>
                </div>
              </div>
            )}

            {activeTab === 'pods' && (
              <div className="details-tab-content node-pods-tab">
                <div className="resource-header node-pods-header">
                  <div>
                    <h2 className="node-pods-title">Pods on {selectedNode.name}</h2>
                    <span className="resource-count">{nodePods.length} {pluralize(nodePods.length, 'item')}</span>
                  </div>
                  <div className="resource-controls">
                    <Button variant="secondary" size="sm" icon="refresh" onClick={pods.refetch} busy={pods.refetching} disabled={pods.loading}>Refresh</Button>
                  </div>
                </div>
                {pods.error && nodePods.length === 0 ? (
                  <ErrorState error={pods.error} title="Couldn't load pods" onRetry={pods.refetch} busy={pods.refetching} />
                ) : (
                  <DataTable
                    caption={`Pods on ${selectedNode.name}`}
                    columns={podColumns}
                    rows={nodePods}
                    rowKey={(pod) => `${pod.namespace}/${pod.name}`}
                    rowName={(pod) => pod.name}
                    onRowActivate={openPod}
                    getRowTone={(pod) => (statusTone('pod', pod.status) === 'bad' ? 'bad' : undefined)}
                    loading={pods.loading}
                    refetching={pods.refetching}
                    emptyState={<EmptyState icon="pod" title="No pods scheduled on this node" size="sm" />}
                    initialSort={{ key: 'name', dir: 'asc' }}
                    storageKey="node-pods"
                  />
                )}
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
