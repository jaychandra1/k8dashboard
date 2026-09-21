import { useMemo } from 'react';
import Icon from './Icons';
import NamespaceMultiSelect from './NamespaceMultiSelect';
import Donut from './ui/Donut';
import Skeleton from './ui/Skeleton';
import ErrorState from './ui/ErrorState';
import useDocumentTitle from '../hooks/useDocumentTitle';
import { podPhaseBucket, BUCKET_TONE, BUCKET_LABEL } from '../lib/status';
import { pluralKey, labelFor } from '../lib/kinds';
import { pct } from '../lib/format';

// KPI cards + "workloads by type" bars — every entry carries the registry KEY so
// navigation never has to guess from a label.
const KPIS = [
  { key: 'pod', sub: 'pods', tone: 'blue', barTone: 'info' },
  { key: 'deployment', sub: 'workloads', tone: 'green', barTone: 'ok' },
  { key: 'statefulSet', sub: 'stateful', tone: 'purple', barTone: 'purple' },
  { key: 'daemonSet', sub: 'per-node', tone: 'cyan', barTone: 'cyan' },
  { key: 'service', sub: 'networking', tone: 'yellow', barTone: 'warn' },
];

const BUCKETS = ['running', 'pending', 'failed', 'succeeded', 'unknown'];

/** Count pods per bucket (shared with Cluster via podPhaseBucket). */
export function bucketPods(pods) {
  const counts = { running: 0, pending: 0, failed: 0, succeeded: 0, unknown: 0 };
  (pods || []).forEach((p) => { counts[podPhaseBucket(p)] += 1; });
  return counts;
}

export default function Overview({
  allResources = {},
  loading = false,
  error = null,
  onResourceTypeChange,
  // `refreshSignal` is accepted but unused: the data arrives via `allResources`.
  context,
  // legacy namespace picker (rendered only when the shell still passes it)
  selectedNamespaces = ['all'],
  namespaces,
  onNamespaceSelect,
}) {
  useDocumentTitle('Overview');
  const hasData = Object.keys(allResources || {}).length > 0;
  const pods = useMemo(() => allResources[pluralKey('pod')] || [], [allResources]);
  const counts = useMemo(() => bucketPods(pods), [pods]);
  const healthy = counts.running + counts.succeeded;

  const cards = KPIS.map((k) => {
    const list = allResources[pluralKey(k.key)] || [];
    const { label, icon } = labelFor(k.key);
    return { ...k, label, icon, value: list.length, sub: k.key === 'pod' ? `${counts.running} running` : k.sub };
  });
  const maxBar = Math.max(...cards.map((b) => b.value), 1);
  const totalObjects = cards.reduce((s, b) => s + b.value, 0);

  const segments = BUCKETS.filter((b) => counts[b] > 0 || b === 'running' || b === 'pending' || b === 'failed')
    .map((b) => ({ key: b, label: BUCKET_LABEL[b], value: counts[b], tone: BUCKET_TONE[b] }));

  const go = (key) => onResourceTypeChange?.(key);

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h1>
          <Icon name="overview" size={18} />
          Cluster Overview{context ? <span className="cluster-version-badge">{context}</span> : null}
        </h1>
        {namespaces && onNamespaceSelect && (
          <NamespaceMultiSelect namespaces={namespaces} selected={selectedNamespaces} onChange={onNamespaceSelect} />
        )}
      </div>

      {error && !hasData ? (
        <div className="dashboard-body"><ErrorState error={error} title="Couldn't load the cluster overview" /></div>
      ) : loading && !hasData ? (
        <div className="dashboard-body" aria-busy="true">
          <div className="kpi-row"><Skeleton block height={84} label="Loading cluster overview" /></div>
          <div className="chart-grid"><Skeleton block height={220} /><Skeleton block height={220} /></div>
        </div>
      ) : (
        <div className="dashboard-body">
          <div className="kpi-row">
            {cards.map((k) => (
              <button key={k.key} type="button" className="kpi-card" onClick={() => go(k.key)} aria-label={`${k.value} ${k.label}, ${k.sub}. Open ${k.label}`}>
                <div className={`kpi-icon ${k.tone}`} aria-hidden="true">
                  <Icon name={k.icon} size={22} />
                </div>
                <div className="kpi-meta">
                  <div className="kpi-value">{k.value}</div>
                  <div className="kpi-label">{k.label}</div>
                  <div className="kpi-sub">{k.sub}</div>
                </div>
              </button>
            ))}
          </div>

          <div className="chart-grid">
            <section className="chart-card" aria-label="Pod health">
              <div className="chart-card-title">
                <h2>Pod Health</h2>
                <span className="total">{pods.length} total</span>
              </div>
              <div className="donut-wrap">
                <Donut
                  segments={segments}
                  centerValue={pods.length ? pct(healthy, pods.length) : '0%'}
                  centerLabel="healthy"
                  ariaLabel="Pod health"
                  legend
                  onSegmentClick={() => go('pod')}
                />
              </div>
            </section>

            <section className="chart-card" aria-label="Workloads by type">
              <div className="chart-card-title">
                <h2>Workloads by Type</h2>
                <span className="total">{totalObjects} objects</span>
              </div>
              <div className="bars">
                {cards.map((b) => (
                  <button key={b.key} type="button" className="bar-row" onClick={() => go(b.key)} aria-label={`${b.label}: ${b.value}. Open ${b.label}`}>
                    <div className="bar-head">
                      <span className="name">
                        <Icon name={b.icon} size={14} />
                        {b.label}
                      </span>
                      <span className="val">{b.value}</span>
                    </div>
                    <div className="bar-track" aria-hidden="true">
                      <div className="bar-fill" data-tone={b.barTone} style={{ width: `${(b.value / maxBar) * 100}%` }} />
                    </div>
                  </button>
                ))}
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
