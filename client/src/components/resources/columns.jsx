// Column definitions for every resource type shown by <ResourceViewer>,
// defined ONCE at module scope (they used to be rebuilt on each render).
//
//   const columns = useMemo(() => columnsFor(resourceType, { icon, onNavigate, podMetrics }), [...]);
//
// Each definition is a <DataTable> column; `render(row, index, ctx)` receives
// the view context (metrics map, navigation) as a third argument.
import Icon from '../Icons';
import Badge from '../ui/Badge';
import Tooltip from '../ui/Tooltip';
import { formatAge, fmtCpu, fmtMem } from '../../lib/format';
import { statusTone } from '../../lib/status';
import { XLink, nsLink, nodeLink } from './links';

const ageCol = { key: 'age', header: 'Age', sortable: true, accessor: (r) => (r.createdAt ? Date.parse(r.createdAt) : null), render: (r) => formatAge(r.createdAt), align: 'right', mono: true, width: 80 };

const nameCol = {
  key: 'name', header: 'Name', sortable: true, ellipsis: true, width: 300, maxWidth: 360,
  render: (r, _i, ctx) => (
    <span className="resource-name-cell">
      <Icon name={ctx.icon} size={15} className="rn-icon" />
      <span className="rn-text">{r.name}</span>
    </span>
  ),
  title: (r) => r.name,
};

// One-click logs, right after the name (pods and deployments). The button
// opens the logs panel; the row itself still opens the details drawer.
const logsCol = {
  key: 'logs', header: <span className="sr-only">Logs</span>, width: 52, align: 'center', className: 'dt-logs',
  render: (r, _i, ctx) => (ctx.onOpenLogs ? (
    <Tooltip content="View logs">
      <button type="button" className="row-logs-btn" aria-label={`Logs for ${r.name}`} onClick={(e) => { e.stopPropagation(); ctx.onOpenLogs(r); }}>
        <Icon name="logs" size={16} />
      </button>
    </Tooltip>
  ) : null),
};

const namespaceCol = {
  key: 'namespace', header: 'Namespace', sortable: true, ellipsis: true, width: 170,
  render: (r, _i, ctx) => (r.namespace
    ? <XLink link={nsLink(r.namespace)} onNavigate={ctx.onNavigate} title={`Filter to ${r.namespace}`}>{r.namespace}</XLink>
    : '—'),
  title: (r) => r.namespace,
};

const statusCol = (kind) => ({
  key: 'status', header: 'Status', sortable: true, width: 140,
  accessor: (r) => r.status || 'Unknown',
  render: (r) => <Badge status={r.status || 'Unknown'} kind={kind} />,
});

const text = (key, header, extra = {}) => ({ key, header, sortable: true, accessor: (r) => r[key] ?? null, render: (r) => (r[key] != null && r[key] !== '' ? r[key] : '—'), ...extra });
const num = (key, header, extra = {}) => ({ key, header, sortable: true, align: 'right', mono: true, accessor: (r) => (r[key] != null ? Number(r[key]) : 0), render: (r) => (r[key] != null ? r[key] : 0), ...extra });

const CONTAINER_LABEL = { running: 'running', pending: 'pending', failed: 'failed', unknown: 'unknown' };

const containersCol = {
  key: 'containers', header: 'Containers', sortable: true, width: 110,
  accessor: (r) => (r.containerStates ? r.containerStates.length : 0),
  render: (r) => {
    const states = r.containerStates;
    if (!states || !states.length) return '—';
    return (
      <span className="container-boxes">
        {states.map((c) => {
          const label = `${c.name}: ${CONTAINER_LABEL[c.status] || c.status || 'unknown'}`;
          return <span key={c.name} className={`container-box ${c.status || 'unknown'}`} role="img" aria-label={label} title={label} />;
        })}
      </span>
    );
  },
};

const metricOf = (r, ctx) => ctx.podMetrics?.[`${r.namespace}/${r.name}`];

const cpuCol = {
  key: 'cpu', header: 'CPU', sortable: true, align: 'right', mono: true, width: 80,
  accessor: (r, ctx) => metricOf(r, ctx)?.cpuMilli ?? null,
  render: (r, _i, ctx) => { const m = metricOf(r, ctx); return m ? <span className="metric-cpu">{fmtCpu(m.cpuMilli)}</span> : '—'; },
};
const memCol = {
  key: 'memory', header: 'Memory', sortable: true, align: 'right', mono: true, width: 90,
  accessor: (r, ctx) => metricOf(r, ctx)?.memBytes ?? null,
  render: (r, _i, ctx) => { const m = metricOf(r, ctx); return m ? <span className="metric-mem">{fmtMem(m.memBytes)}</span> : '—'; },
};

const nodeCol = {
  key: 'node', header: 'Node', sortable: true, ellipsis: true, width: 180,
  render: (r, _i, ctx) => (r.node ? <XLink link={nodeLink(r.node)} onNavigate={ctx.onNavigate} title={`View node ${r.node}`}>{r.node}</XLink> : '—'),
  title: (r) => r.node,
};

const COLUMNS = {
  pod: [nameCol, logsCol, namespaceCol, containersCol, cpuCol, memCol, num('restarts', 'Restarts', { width: 90 }), nodeCol, ageCol, statusCol('pod')],
  deployment: [nameCol, logsCol, namespaceCol, statusCol()],
  configMap: [nameCol, namespaceCol, num('dataKeys', 'Keys', { width: 80 }), ageCol],
  secret: [nameCol, namespaceCol, { key: 'secretType', header: 'Type', sortable: true, accessor: (r) => r.secretType || 'Opaque', render: (r) => <span className="drawer-chip">{r.secretType || 'Opaque'}</span> }, num('dataKeys', 'Keys', { width: 80 }), ageCol],
  serviceAccount: [nameCol, namespaceCol, num('saSecrets', 'Secrets', { width: 90 }), ageCol],
  ingress: [nameCol, namespaceCol, text('ingressClass', 'Class'), text('hosts', 'Hosts', { ellipsis: true, maxWidth: 320 }), ageCol],
  networkPolicy: [nameCol, namespaceCol, text('policyTypes', 'Policy Types'), ageCol],
  persistentVolumeClaim: [nameCol, namespaceCol, statusCol('persistentVolumeClaim'), text('capacity', 'Capacity', { mono: true }), text('storageClass', 'Storage Class'), text('volume', 'Volume', { ellipsis: true }), ageCol],
  persistentVolume: [nameCol, text('capacity', 'Capacity', { mono: true }), text('accessModes', 'Access Modes'), text('reclaimPolicy', 'Reclaim Policy'), statusCol('persistentVolume'), text('storageClass', 'Storage Class'), text('claim', 'Claim', { ellipsis: true }), ageCol],
  storageClass: [nameCol, text('provisioner', 'Provisioner', { mono: true, ellipsis: true, maxWidth: 320 }), text('reclaimPolicy', 'Reclaim Policy'), text('bindingMode', 'Binding Mode'), ageCol],
};

const DEFAULT_COLUMNS = [nameCol, namespaceCol, statusCol()];

/** Row tone for the left accent bar: only failures are flagged. */
export const rowToneFor = (kind) => (r) => (statusTone(kind, r.status) === 'bad' ? 'bad' : undefined);

/**
 * Bind the static definitions to a view context so <DataTable> can call
 * `render(row, i)` / `accessor(row)`.
 */
export function columnsFor(resourceType, ctx = {}) {
  const defs = COLUMNS[resourceType] || DEFAULT_COLUMNS;
  return defs.map((c) => ({
    ...c,
    render: c.render ? (r, i) => c.render(r, i, ctx) : undefined,
    accessor: c.accessor ? (r) => c.accessor(r, ctx) : undefined,
  }));
}

export const COLUMN_TYPES = Object.keys(COLUMNS);
