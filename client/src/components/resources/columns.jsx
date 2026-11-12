// Column definitions for every resource type shown by <ResourceViewer>,
// defined ONCE at module scope (they used to be rebuilt on each render).
//
//   const columns = useMemo(() => columnsFor(resourceType, { icon, onNavigate, podMetrics }), [...]);
//
// Each definition is a <DataTable> column; `render(row, index, ctx)` receives
// the view context (metrics map, navigation) as a third argument.
//
// Every column names its width: the lists use <DataTable fixedColumns>, so a
// column is exactly that wide whatever the rows hold and the table doesn't
// move as rows scroll or sort into view. A width covers the column's header
// (HEADER_ROOM below is checked by columns.test.jsx) and its usual values;
// longer values are cut with an ellipsis and shown in the cell's tooltip.
// The name takes spare room when a name needs it (width → maxWidth, nameRoom);
// the last column takes the rest.
import Icon from '../Icons';
import Badge from '../ui/Badge';
import Tooltip from '../ui/Tooltip';
import { formatAge, formatAgeSeconds, fmtCpu, fmtMem } from '../../lib/format';
import { statusTone } from '../../lib/status';
import { XLink, nsLink, nodeLink } from './links';

/** The least a sortable column needs for its header: padding, the label in capitals, the sort arrow. */
export const HEADER_ROOM = (label) => 48 + Math.ceil(String(label).length * 8.5);

const ageCol = { key: 'age', header: 'Age', sortable: true, accessor: (r) => (r.createdAt ? Date.parse(r.createdAt) : null), render: (r) => formatAge(r.createdAt), align: 'right', mono: true, width: 80 };

/** The room the longest name needs, in px: its text (about 6.6px a character), the icon and the cell padding. */
export const nameRoom = (rows) => 56 + Math.ceil(6.6 * rows.reduce((n, r) => Math.max(n, r?.name?.length || 0), 0));

const nameCol = {
  // 300px shows a 36-character name in full. When the list has longer names and
  // the window has room, the column grows to fit them, up to 460px (about 60).
  key: 'name', header: 'Name', sortable: true, ellipsis: true, width: 300, maxWidth: 460, fit: nameRoom,
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
  key: 'logs', header: <span className="sr-only">Logs</span>, width: 60, align: 'center', className: 'dt-logs',
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

// 160px: CrashLoopBackOff, ImagePullBackOff and ContainerCreating in full. The
// rare longer ones (ContainerStatusUnknown, CreateContainerConfigError) are cut
// short; the tooltip and the details panel have them whole.
const statusCol = (kind) => ({
  key: 'status', header: 'Status', sortable: true, width: 160,
  accessor: (r) => r.status || 'Unknown',
  render: (r) => <Badge status={r.status || 'Unknown'} kind={kind} />,
  title: (r) => r.status || 'Unknown',
});

const text = (key, header, extra = {}) => ({
  key, header, sortable: true, ellipsis: true,
  accessor: (r) => r[key] ?? null,
  render: (r) => (r[key] != null && r[key] !== '' ? r[key] : '—'),
  title: (r) => (r[key] != null && r[key] !== '' ? String(r[key]) : undefined),
  ...extra,
});
const num = (key, header, extra = {}) => ({ key, header, sortable: true, align: 'right', mono: true, accessor: (r) => (r[key] != null ? Number(r[key]) : 0), render: (r) => (r[key] != null ? r[key] : 0), ...extra });

const CONTAINER_LABEL = { running: 'running', pending: 'pending', failed: 'failed', unknown: 'unknown' };

const containersCol = {
  key: 'containers', header: 'Containers', sortable: true, width: 134,
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
  key: 'memory', header: 'Memory', sortable: true, align: 'right', mono: true, width: 100,
  accessor: (r, ctx) => metricOf(r, ctx)?.memBytes ?? null,
  render: (r, _i, ctx) => { const m = metricOf(r, ctx); return m ? <span className="metric-mem">{fmtMem(m.memBytes)}</span> : '—'; },
};

const nodeCol = {
  key: 'node', header: 'Node', sortable: true, ellipsis: true, width: 200,
  render: (r, _i, ctx) => (r.node ? <XLink link={nodeLink(r.node)} onNavigate={ctx.onNavigate} title={`View node ${r.node}`}>{r.node}</XLink> : '—'),
  title: (r) => r.node,
};

// The workload that owns a ReplicaSet / Job ("Deployment web", "CronJob backup").
const ownerCol = text('owner', 'Controlled By', { width: 240 });
// `kubectl get rs` columns: desired / current / ready.
const replicaCols = [num('desired', 'Desired', { width: 108 }), num('current', 'Current', { width: 108 }), num('ready', 'Ready', { width: 92 })];
const durationCol = {
  key: 'duration', header: 'Duration', sortable: true, align: 'right', mono: true, width: 116,
  accessor: (r) => r.durationSeconds ?? null,
  render: (r) => (r.durationSeconds != null ? formatAgeSeconds(r.durationSeconds) : '—'),
};
const lastScheduleCol = {
  key: 'lastSchedule', header: 'Last Schedule', sortable: true, align: 'right', mono: true, width: 160,
  accessor: (r) => (r.lastSchedule ? Date.parse(r.lastSchedule) : null),
  render: (r) => (r.lastSchedule ? `${formatAge(r.lastSchedule)} ago` : '—'),
};

const COLUMNS = {
  // Status early: at 1280px the last columns need a horizontal scroll.
  pod: [nameCol, logsCol, namespaceCol, statusCol('pod'), containersCol, cpuCol, memCol, num('restarts', 'Restarts', { width: 116 }), nodeCol, ageCol],
  deployment: [nameCol, logsCol, namespaceCol, statusCol()],
  // The type is not a status: a plain chip, no status dot.
  service: [nameCol, namespaceCol, { key: 'serviceType', header: 'Type', sortable: true, width: 150, accessor: (r) => r.serviceType || r.status || '', render: (r) => <span className="drawer-chip">{r.serviceType || r.status || '—'}</span> }, text('ports', 'Ports', { mono: true, width: 260 }), ageCol],
  replicaSet: [nameCol, namespaceCol, ...replicaCols, ownerCol, ageCol],
  replicationController: [nameCol, namespaceCol, ...replicaCols, ageCol],
  job: [nameCol, namespaceCol, statusCol('job'), text('completions', 'Completions', { mono: true, width: 142 }), durationCol, ownerCol, ageCol],
  cronJob: [nameCol, namespaceCol, statusCol('cronJob'), text('schedule', 'Schedule', { mono: true, width: 170 }), lastScheduleCol, num('activeJobs', 'Active', { width: 100 }), ageCol],
  configMap: [nameCol, namespaceCol, num('dataKeys', 'Keys', { width: 84 }), ageCol],
  secret: [nameCol, namespaceCol, { key: 'secretType', header: 'Type', sortable: true, width: 280, accessor: (r) => r.secretType || 'Opaque', render: (r) => <span className="drawer-chip">{r.secretType || 'Opaque'}</span>, title: (r) => r.secretType || 'Opaque' }, num('dataKeys', 'Keys', { width: 84 }), ageCol],
  serviceAccount: [nameCol, namespaceCol, num('saSecrets', 'Secrets', { width: 108 }), ageCol],
  ingress: [nameCol, namespaceCol, text('ingressClass', 'Class', { width: 150 }), text('hosts', 'Hosts', { width: 320 }), ageCol],
  networkPolicy: [nameCol, namespaceCol, text('policyTypes', 'Policy Types', { width: 170 }), ageCol],
  persistentVolumeClaim: [nameCol, namespaceCol, statusCol('persistentVolumeClaim'), text('capacity', 'Capacity', { mono: true, width: 116 }), text('storageClass', 'Storage Class', { width: 170 }), text('volume', 'Volume', { width: 300 }), ageCol],
  persistentVolume: [nameCol, text('capacity', 'Capacity', { mono: true, width: 116 }), text('accessModes', 'Access Modes', { width: 150 }), text('reclaimPolicy', 'Reclaim Policy', { width: 168 }), statusCol('persistentVolume'), text('storageClass', 'Storage Class', { width: 170 }), text('claim', 'Claim', { width: 280 }), ageCol],
  storageClass: [nameCol, text('provisioner', 'Provisioner', { mono: true, width: 300 }), text('reclaimPolicy', 'Reclaim Policy', { width: 168 }), text('bindingMode', 'Binding Mode', { width: 200 }), ageCol],
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
  // The last column takes the spare width, so a table with few columns keeps
  // name, logs, namespace… together instead of spreading them across the page.
  return defs.map((c, i) => ({
    ...c,
    fill: c.fill ?? i === defs.length - 1,
    render: c.render ? (r, i) => c.render(r, i, ctx) : undefined,
    accessor: c.accessor ? (r) => c.accessor(r, ctx) : undefined,
  }));
}

export const COLUMN_TYPES = Object.keys(COLUMNS);
