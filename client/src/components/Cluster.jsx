import Icon from './Icons';
import Donut from './ui/Donut';
import LoadingScreen from './shell/LoadingScreen';
import ErrorState from './ui/ErrorState';
import useRequest from '../hooks/useRequest';
import useDocumentTitle from '../hooks/useDocumentTitle';
import { getJson, p } from '../lib/api';
import { podPhaseBucket, BUCKET_TONE, BUCKET_LABEL } from '../lib/status';
import { fmtMem, pct } from '../lib/format';
import { labelFor } from '../lib/kinds';

/** Fold the summary's `{ Running: n, … }` phase counts into the shared buckets. */
export function bucketPhases(phases) {
  const counts = { running: 0, pending: 0, failed: 0, succeeded: 0, unknown: 0 };
  Object.entries(phases || {}).forEach(([phase, n]) => { counts[podPhaseBucket({ status: phase })] += Number(n) || 0; });
  return counts;
}

const EMPTY_BUCKETS = { running: 0, pending: 0, failed: 0, succeeded: 0, unknown: 0 };
/** Pod health counts: the server's container-aware buckets (a crash-looping pod is failing). */
export function podCounts(pods) {
  return pods?.buckets ? { ...EMPTY_BUCKETS, ...pods.buckets } : bucketPhases(pods?.phases);
}

// The Workloads card: one tile per kind, cluster-wide (every namespace).
export const WORKLOAD_TILES = [
  { kind: 'deployments', key: 'deployment', tone: 'green' },
  { kind: 'statefulSets', key: 'statefulSet', tone: 'purple' },
  { kind: 'daemonSets', key: 'daemonSet', tone: 'cyan' },
  { kind: 'jobs', key: 'job', tone: 'blue' },
  { kind: 'cronJobs', key: 'cronJob', tone: 'yellow' },
  { kind: 'services', key: 'service', tone: 'blue' },
];

/** One line on how a kind is doing: { tone, text, title? }. */
export function workloadStatus(kind, s) {
  if (!s) return { tone: 'muted', text: '—' };
  if (s.error) return { tone: 'muted', text: 'Not available', title: s.error };
  if (!s.total) return { tone: 'muted', text: 'None' };
  if (kind === 'deployments' || kind === 'statefulSets' || kind === 'daemonSets') {
    const scaled = s.scaledDown ? ` · ${s.scaledDown} scaled to 0` : '';
    return s.notReady ? { tone: 'warn', text: `${s.notReady} not ready${scaled}` } : { tone: 'ok', text: `All ready${scaled}` };
  }
  if (kind === 'jobs') {
    if (s.failed) return { tone: 'bad', text: `${s.failed} failed` };
    return s.active ? { tone: 'info', text: `${s.active} running` } : { tone: 'ok', text: 'All complete' };
  }
  if (kind === 'cronJobs') return s.suspended ? { tone: 'muted', text: `${s.suspended} suspended` } : { tone: 'ok', text: 'All scheduled' };
  return { tone: 'muted', text: 'Networking' };
}

function WorkloadsCard({ workloads, onOpen }) {
  const tiles = WORKLOAD_TILES.map((t) => ({ ...t, ...labelFor(t.key), summary: workloads?.[t.kind] }));
  const total = tiles.reduce((n, t) => n + (t.summary?.total || 0), 0);
  return (
    <section className="chart-card wl-card" aria-label="Workloads">
      <div className="chart-card-title">
        <h2>Workloads</h2>
        <span className="total">{total} objects · all namespaces</span>
      </div>
      <div className="wl-grid">
        {tiles.map((t) => {
          const st = workloadStatus(t.kind, t.summary);
          const count = t.summary?.error ? '—' : (t.summary?.total ?? '—');
          return (
            <button
              key={t.kind}
              type="button"
              className="wl-tile"
              onClick={() => onOpen?.(t.key)}
              disabled={!onOpen}
              title={st.title}
              aria-label={`${t.label}: ${count}, ${st.text}. Open ${t.label}`}
            >
              <span className={`kpi-icon ${t.tone}`} aria-hidden="true"><Icon name={t.icon} size={17} /></span>
              <span className="wl-meta">
                <span className="wl-label">{t.label}</span>
                <span className="wl-count">{count}</span>
              </span>
              <span className="wl-status" data-tone={st.tone}><i aria-hidden="true" />{st.text}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

const fmtCores = (milli) => {
  const c = (Number(milli) || 0) / 1000;
  return c >= 10 ? c.toFixed(0) : c.toFixed(1).replace(/\.0$/, '');
};
const shareOf = (part, total) => (total > 0 ? (part / total) * 100 : 0);
// Requested share → warning tones (the resource keeps its colour below 75%).
const loadTone = (pctValue) => (pctValue >= 90 ? 'bad' : pctValue >= 75 ? 'warn' : null);

/**
 * One resource of the capacity card: what the scheduler has reserved
 * (requests, light fill) and what is used now (solid fill) of what the nodes
 * can run, plus the limits' share (above 100% = overcommitted).
 */
export function ResourceBar({ label, icon, tone, requested, allocatable, used, limits, fmt, unit = '', verb = 'requested' }) {
  const req = shareOf(requested, allocatable);
  const use = used != null ? shareOf(used, allocatable) : null;
  const lim = limits != null ? shareOf(limits, allocatable) : null;
  const warn = loadTone(req);
  const t = warn || tone;
  const summary = `${label}: ${fmt(requested)} of ${fmt(allocatable)}${unit} ${verb} (${Math.round(req)}%)`
    + (use != null ? `, ${fmt(used)}${unit} in use` : '')
    + (lim != null ? `, limits ${Math.round(lim)}% of allocatable` : '');
  return (
    <div className="cap-row" role="group" aria-label={summary}>
      <div className="bar-head">
        <span className="name"><Icon name={icon} size={14} /> {label}</span>
        <span className="cap-pct" data-tone={warn || undefined}>{Math.round(req)}%</span>
      </div>
      <div className="cap-track" aria-hidden="true">
        <div className="cap-req" data-tone={t} data-solid={use == null || undefined} style={{ width: `${Math.min(100, req)}%` }} />
        {use != null && <div className="cap-use" data-tone={t} style={{ width: `${Math.min(100, use)}%` }} />}
      </div>
      <div className="cap-sub" aria-hidden="true">
        <span><b>{fmt(requested)}</b> of {fmt(allocatable)}{unit} {verb}</span>
        {use != null && <span><b>{fmt(used)}</b>{unit} in use</span>}
        {lim != null && lim > 0 && (
          <span className={lim > 100 ? 'cap-over' : undefined} title="The containers' limits added up. Above 100% the nodes are overcommitted: the pods can't all use their limits at once.">
            limits {Math.round(lim)}%
          </span>
        )}
      </div>
    </div>
  );
}

/** Requests / usage vs allocatable for CPU, memory and pod slots. */
export function CapacityCard({ cap }) {
  const usage = cap.usage?.available ? cap.usage : null;
  const waiting = cap.podsUnscheduled || 0;
  return (
    <section className="chart-card cap-card" aria-label="Cluster capacity">
      <div className="chart-card-title">
        <h2>Cluster Capacity</h2>
        <span className="total">requested of allocatable</span>
      </div>
      <div className="cap-rows">
        <ResourceBar label="CPU" icon="cpu" tone="info" fmt={fmtCores} unit=" cores"
          requested={cap.cpuRequestedMilli} allocatable={cap.cpuAllocatableMilli} used={usage?.cpuMilli} limits={cap.cpuLimitsMilli} />
        <ResourceBar label="Memory" icon="memory" tone="purple" fmt={fmtMem}
          requested={cap.memRequestedBytes} allocatable={cap.memAllocatableBytes} used={usage?.memBytes} limits={cap.memLimitsBytes} />
        <ResourceBar label="Pods" icon="pod" tone="cyan" fmt={(n) => String(n ?? 0)} unit=" pods"
          requested={cap.podsScheduled} allocatable={cap.podsAllocatable} verb="scheduled" />
      </div>
      <div className="cap-foot">
        {usage ? (
          <span className="cap-legend" aria-hidden="true">
            <i className="cap-key cap-key-req" /> requested
            <i className="cap-key cap-key-use" /> in use
          </span>
        ) : (
          <span className="cap-note">Live usage needs metrics-server in the cluster.</span>
        )}
        {waiting > 0 && (
          <span className="cap-note" data-tone="warn">
            <Icon name="warning" size={13} /> {waiting} {waiting === 1 ? 'pod is' : 'pods are'} waiting for a node with room
          </span>
        )}
      </div>
    </section>
  );
}

function CapacityBar({ label, icon, used, total, unit, tone }) {
  const share = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return (
    <div className="bar-row" role="group" aria-label={`${label}: ${used}${unit} allocatable of ${total}${unit}`}>
      <div className="bar-head">
        <span className="name"><Icon name={icon} size={14} /> {label}</span>
        <span className="val">{used}{unit} / {total}{unit}</span>
      </div>
      <div className="bar-track" aria-hidden="true">
        <div className="bar-fill" data-tone={tone} style={{ width: `${share}%` }} />
      </div>
    </div>
  );
}

// The Dashboard: the whole cluster at a glance (every namespace) — nodes,
// pods, capacity and workloads. `onOpen(viewKey)` opens a list across all
// namespaces (the counts here are cluster-wide).
// `onSummaryLoaded(contextName)` fires on every successful summary fetch with
// the context the payload belongs to; the shell uses it to end the
// context-switch loading screen once the new cluster's data is on screen.
export default function Cluster({ refreshSignal = 0, context, onSummaryLoaded, onOpen }) {
  useDocumentTitle('Dashboard');
  const { data, error, loading, refetching, refetch } = useRequest(
    ({ signal }) => getJson(p('api', 'cluster', 'summary'), { signal }),
    {
      deps: [refreshSignal, context],
      dedupeKey: 'cluster:summary',
      onSuccess: (d) => onSummaryLoaded?.(d?.currentContext || context || ''),
    },
  );

  const counts = podCounts(data?.pods);
  const podTotal = data?.pods?.total || 0;
  const healthy = counts.running + counts.succeeded;
  const podSegments = ['running', 'pending', 'failed', 'succeeded', 'unknown']
    .filter((b) => counts[b] > 0 || b === 'running' || b === 'pending' || b === 'failed')
    .map((b) => ({ key: b, label: BUCKET_LABEL[b], value: counts[b], tone: BUCKET_TONE[b] }));

  const nodesReady = data?.nodes?.ready || 0;
  const nodeTotal = data?.nodes?.total || 0;
  const nodeSegments = [
    { key: 'ready', label: 'Ready', value: nodesReady, tone: 'ok' },
    { key: 'notReady', label: 'Not Ready', value: data?.nodes?.notReady || 0, tone: 'bad' },
  ];

  const cap = data?.capacity || {};
  const roleEntries = Object.entries(data?.roles || {});
  const partialErrors = data?.partial ? (data.errors || []) : [];

  const kpis = data ? [
    { key: 'nodes', label: 'Nodes', value: `${nodesReady}/${nodeTotal}`, sub: 'ready', icon: 'nodes', tone: 'blue', open: 'nodes' },
    { key: 'cpu', label: 'CPU Cores', value: cap.cpuCapacity ?? '—', sub: `${cap.cpuAllocatable ?? '—'} allocatable`, icon: 'cpu', tone: 'green' },
    { key: 'memory', label: 'Memory', value: fmtMem(cap.memCapacityBytes), sub: `${fmtMem(cap.memAllocatableBytes)} allocatable`, icon: 'memory', tone: 'purple' },
    {
      key: 'pods', label: 'Pods', value: podTotal, icon: 'pod', tone: 'cyan', open: 'pod',
      sub: counts.failed ? `${counts.running} running · ${counts.failed} failing` : `${counts.running} running`,
      subTone: counts.failed ? 'bad' : undefined,
    },
    { key: 'namespaces', label: 'Namespaces', value: data.namespaceCount ?? '—', sub: 'total', icon: 'apps', tone: 'yellow', open: 'namespaces' },
  ] : [];

  const title = data?.currentContext || context || 'Cluster';

  // First load: the branded loading screen fills the page (the same screen the
  // shell shows during startup and a context switch). The heading stays for
  // screen readers.
  if (loading && !data) {
    return (
      <div className="dashboard dashboard--loading" aria-busy="true">
        <h1 className="sr-only">{title}</h1>
        <LoadingScreen context={context || undefined} />
      </div>
    );
  }

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h1>
          <Icon name="cluster" size={19} />
          {title}
          {data?.serverVersion && data.serverVersion !== 'unknown' && <span className="cluster-version-badge">{data.serverVersion}</span>}
        </h1>
        <span className="resource-refreshing" aria-live="polite" role="status">{refetching ? 'Refreshing…' : ''}</span>
      </div>

      {partialErrors.length > 0 && (
        <div className="partial-banner" role="status">
          <Icon name="warning" size={14} />
          <span>Some information could not be loaded: {partialErrors.map((e) => `${e.kind}${e.error ? ` (${e.error})` : ''}`).join('; ')}</span>
        </div>
      )}

      {error && !data && <div className="dashboard-body"><ErrorState error={error} title="Couldn't load the cluster summary" onRetry={refetch} busy={refetching} /></div>}

      {data && (
        <div className="dashboard-body">
          {error && <ErrorState compact error={error} title="Latest refresh failed — showing previous data" onRetry={refetch} busy={refetching} />}
          <div className="kpi-row">
            {kpis.map((k) => {
              const body = (
                <>
                  <div className={`kpi-icon ${k.tone}`} aria-hidden="true"><Icon name={k.icon} size={22} /></div>
                  <div className="kpi-meta">
                    <div className="kpi-value">{k.value}</div>
                    <div className="kpi-label">{k.label}</div>
                    <div className="kpi-sub" data-tone={k.subTone}>{k.sub}</div>
                  </div>
                </>
              );
              return k.open && onOpen ? (
                <button key={k.key} type="button" className="kpi-card" onClick={() => onOpen(k.open)} aria-label={`${k.value} ${k.label}, ${k.sub}. Open ${k.label}`}>{body}</button>
              ) : (
                <div key={k.key} className="kpi-card" data-static>{body}</div>
              );
            })}
          </div>

          <div className="chart-grid">
            <section className="chart-card" aria-label="Node health">
              <div className="chart-card-title">
                <h2>Node Health</h2>
                <span className="total">{nodeTotal} nodes</span>
              </div>
              <div className="donut-wrap">
                <Donut segments={nodeSegments} centerValue={nodeTotal ? pct(nodesReady, nodeTotal) : '0%'} centerLabel="ready" ariaLabel="Node health" legend />
              </div>
            </section>

            <section className="chart-card" aria-label="Pod health">
              <div className="chart-card-title">
                <h2>Pod Health</h2>
                <span className="total">{podTotal} pods</span>
              </div>
              <div className="donut-wrap">
                <Donut
                  segments={podSegments}
                  centerValue={podTotal ? pct(healthy, podTotal) : '0%'}
                  centerLabel="healthy"
                  ariaLabel="Pod health"
                  legend
                  onSegmentClick={onOpen ? () => onOpen('pod') : undefined}
                />
              </div>
            </section>

            {cap.cpuRequestedMilli != null ? <CapacityCard cap={cap} /> : (
              // A server without the requests data: allocatable vs total.
              <section className="chart-card" aria-label="Cluster capacity">
                <div className="chart-card-title">
                  <h2>Cluster Capacity</h2>
                  <span className="total">allocatable / total</span>
                </div>
                <div className="bars">
                  <CapacityBar label="CPU" icon="cpu" used={cap.cpuAllocatable ?? 0} total={cap.cpuCapacity ?? 0} unit=" cores" tone="info" />
                  <CapacityBar
                    label="Memory" icon="memory"
                    used={Math.round((cap.memAllocatableBytes || 0) / 1024 ** 3)}
                    total={Math.round((cap.memCapacityBytes || 0) / 1024 ** 3)}
                    unit=" GiB" tone="purple"
                  />
                </div>
              </section>
            )}
          </div>

          <WorkloadsCard workloads={data.workloads} onOpen={onOpen} />

          <div className="cluster-info-container">
            <section className="cluster-info-card" aria-label="Node roles">
              <h3><Icon name="nodes" size={15} /> Node Roles</h3>
              {roleEntries.length === 0 ? (
                <div className="info-item"><label>No roles reported</label></div>
              ) : roleEntries.map(([role, count]) => (
                <div key={role} className="info-item">
                  <label>{role}</label>
                  <span className="context-value">{count}</span>
                </div>
              ))}
            </section>

            <section className="cluster-info-card" aria-label="Cluster info">
              <h3><Icon name="details" size={15} /> Cluster Info</h3>
              <div className="info-item"><label>Kubernetes Version</label><span className="context-value">{data.serverVersion || '—'}</span></div>
              <div className="info-item"><label>Platform</label><span className="context-value">{data.platform || '—'}</span></div>
              <div className="info-item"><label>Kubelet</label><span className="context-value">{(data.versions || []).join(', ') || '—'}</span></div>
              <div className="info-item"><label>OS Image</label><span className="context-value">{(data.osImages || []).join(', ') || '—'}</span></div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
