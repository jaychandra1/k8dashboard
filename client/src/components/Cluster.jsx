import Icon from './Icons';
import Donut from './ui/Donut';
import Skeleton from './ui/Skeleton';
import ErrorState from './ui/ErrorState';
import useRequest from '../hooks/useRequest';
import useDocumentTitle from '../hooks/useDocumentTitle';
import { getJson, p } from '../lib/api';
import { podPhaseBucket, BUCKET_TONE, BUCKET_LABEL } from '../lib/status';
import { fmtMem, pct } from '../lib/format';

/** Fold the summary's `{ Running: n, … }` phase counts into the shared buckets. */
export function bucketPhases(phases) {
  const counts = { running: 0, pending: 0, failed: 0, succeeded: 0, unknown: 0 };
  Object.entries(phases || {}).forEach(([phase, n]) => { counts[podPhaseBucket({ status: phase })] += Number(n) || 0; });
  return counts;
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

export default function Cluster({ refreshSignal = 0, context }) {
  useDocumentTitle('Cluster');
  const { data, error, loading, refetching, refetch } = useRequest(
    ({ signal }) => getJson(p('api', 'cluster', 'summary'), { signal }),
    { deps: [refreshSignal, context], dedupeKey: 'cluster:summary' },
  );

  const counts = bucketPhases(data?.pods?.phases);
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
    { key: 'nodes', label: 'Nodes', value: `${nodesReady}/${nodeTotal}`, sub: 'ready', icon: 'nodes', tone: 'blue' },
    { key: 'cpu', label: 'CPU Cores', value: cap.cpuCapacity ?? '—', sub: `${cap.cpuAllocatable ?? '—'} allocatable`, icon: 'cpu', tone: 'green' },
    { key: 'memory', label: 'Memory', value: fmtMem(cap.memCapacityBytes), sub: `${fmtMem(cap.memAllocatableBytes)} alloc`, icon: 'memory', tone: 'purple' },
    { key: 'pods', label: 'Pods', value: podTotal, sub: `${counts.running} running`, icon: 'pod', tone: 'cyan' },
    { key: 'namespaces', label: 'Namespaces', value: data.namespaceCount ?? '—', sub: 'total', icon: 'apps', tone: 'yellow' },
  ] : [];

  const title = data?.currentContext || context || 'Cluster';

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

      {loading && !data && (
        <div className="dashboard-body" aria-busy="true">
          <div className="kpi-row"><Skeleton block height={84} label="Loading cluster information" /></div>
          <div className="chart-grid"><Skeleton block height={220} /><Skeleton block height={220} /><Skeleton block height={220} /></div>
        </div>
      )}
      {error && !data && <div className="dashboard-body"><ErrorState error={error} title="Couldn't load the cluster summary" onRetry={refetch} busy={refetching} /></div>}

      {data && (
        <div className="dashboard-body">
          {error && <ErrorState compact error={error} title="Latest refresh failed — showing previous data" onRetry={refetch} busy={refetching} />}
          <div className="kpi-row">
            {kpis.map((k) => (
              <div key={k.key} className="kpi-card" data-static>
                <div className={`kpi-icon ${k.tone}`} aria-hidden="true"><Icon name={k.icon} size={22} /></div>
                <div className="kpi-meta">
                  <div className="kpi-value">{k.value}</div>
                  <div className="kpi-label">{k.label}</div>
                  <div className="kpi-sub">{k.sub}</div>
                </div>
              </div>
            ))}
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
                <Donut segments={podSegments} centerValue={podTotal ? pct(healthy, podTotal) : '0%'} centerLabel="healthy" ariaLabel="Pod health" legend />
              </div>
            </section>

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
          </div>

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

            <section className="cluster-info-card" aria-label="Contexts">
              <h3><Icon name="apps" size={15} /> Contexts ({(data.contexts || []).length})</h3>
              <div className="contexts-list">
                {(data.contexts || []).map((ctx) => (
                  <div key={ctx} className="context-item">
                    <span className={ctx === data.currentContext ? 'active' : ''} aria-current={ctx === data.currentContext ? 'true' : undefined}>{ctx}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="cluster-info-card" aria-label="Clusters">
              <h3><Icon name="cluster" size={15} /> Clusters ({(data.clusters || []).length})</h3>
              <div className="clusters-list">
                {(data.clusters || []).map((cluster) => (
                  <div key={cluster} className="cluster-item"><span>{cluster}</span></div>
                ))}
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
