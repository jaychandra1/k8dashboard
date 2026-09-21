import { useId, useMemo, useState } from 'react';
import Icon from './Icons';
import DataTable from './ui/DataTable';
import Badge from './ui/Badge';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import ErrorState from './ui/ErrorState';
import Skeleton from './ui/Skeleton';
import HighlightedCode from './ui/HighlightedCode';
import useRequest from '../hooks/useRequest';
import useDocumentTitle from '../hooks/useDocumentTitle';
import { getJson, p } from '../lib/api';
import { formatAge, parseHelmDate, pluralize } from '../lib/format';
import { statusTone } from '../lib/status';
import { XLink, nsLink } from './resources/links';

const TABS = [
  { key: 'values', label: 'Values', icon: 'values' },
  { key: 'manifest', label: 'Manifest', icon: 'manifest' },
];

const releaseKey = (r) => `${r.namespace}/${r.name}`;

export default function Helm({ refreshSignal = 0, onNavigate }) {
  useDocumentTitle('Helm');
  const uid = useId();
  const [selected, setSelected] = useState(null); // release
  const [tab, setTab] = useState('values');

  const { data, error, loading, refetching, refetch } = useRequest(
    ({ signal }) => getJson(p('api', 'helm', 'releases'), { signal }),
    { deps: [refreshSignal], dedupeKey: 'helm:releases' },
  );
  const releases = data?.releases || [];

  // Values / manifest keyed by (release, tab): a stale response can never land
  // on the wrong tab because useRequest aborts + ignores superseded runs.
  const detail = useRequest(
    ({ signal }) => getJson(p('api', 'helm', 'releases', selected.namespace, selected.name, tab), { signal }),
    { deps: [selected?.namespace, selected?.name, tab, refreshSignal], enabled: !!selected, keepPreviousData: false, dedupeKey: selected ? `helm:${selected.namespace}/${selected.name}/${tab}` : undefined },
  );

  const columns = useMemo(() => [
    { key: 'name', header: 'Name', sortable: true, ellipsis: true, width: 260, render: (r) => <span className="resource-name-cell"><Icon name="helm" size={15} className="rn-icon" /><span className="rn-text">{r.name}</span></span>, title: (r) => r.name },
    { key: 'namespace', header: 'Namespace', sortable: true, ellipsis: true, width: 160, render: (r) => <XLink className="xlink tone-info" link={nsLink(r.namespace)} onNavigate={onNavigate} title={`Filter to ${r.namespace}`}>{r.namespace}</XLink>, title: (r) => r.namespace },
    { key: 'chart', header: 'Chart', sortable: true, ellipsis: true, width: 220, render: (r) => r.chart || '—', title: (r) => r.chart },
    { key: 'appVersion', header: 'App Version', sortable: true, mono: true, width: 120, render: (r) => r.appVersion || '—' },
    { key: 'revision', header: 'Revision', sortable: true, align: 'right', mono: true, width: 90, accessor: (r) => Number(r.revision) || 0, render: (r) => r.revision || '—' },
    { key: 'status', header: 'Status', sortable: true, width: 140, accessor: (r) => r.status || '', render: (r) => <Badge status={r.status || 'unknown'} kind="helm" /> },
    { key: 'updated', header: 'Updated', sortable: true, align: 'right', mono: true, width: 90, accessor: (r) => parseHelmDate(r.updated)?.getTime() ?? (r.updated ? Date.parse(r.updated) : null), render: (r) => formatAge(r.updated) },
  ], [onNavigate]);

  const select = (r) => { setSelected(r); setTab('values'); };
  const onTabKey = (e, idx) => {
    let next = null;
    if (e.key === 'ArrowRight') next = (idx + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next == null) return;
    e.preventDefault();
    setTab(TABS[next].key);
    e.currentTarget.parentElement?.querySelector(`[data-tab="${TABS[next].key}"]`)?.focus();
  };

  return (
    <div className="resource-viewer">
      <div className="resource-header">
        <div>
          <h1 className="resource-title">
            <Icon name="helm" size={18} />
            Helm Releases
          </h1>
          <span className="resource-count">{releases.length} {pluralize(releases.length, 'item')}</span>
          <span className="resource-refreshing" aria-live="polite" role="status">{refetching ? 'Refreshing…' : ''}</span>
        </div>
        <div className="resource-controls" />
      </div>

      <div className="resource-table-wrapper">
        {error && releases.length === 0 ? (
          <ErrorState error={error} title="Couldn't load Helm releases" onRetry={refetch} busy={refetching} />
        ) : (
          <DataTable
            caption="Helm releases"
            columns={columns}
            rows={releases}
            rowKey={releaseKey}
            rowName={(r) => r.name}
            activeKey={selected ? releaseKey(selected) : null}
            onRowActivate={select}
            rowActions={(r) => [
              { icon: 'values', label: 'Values', onSelect: () => { setSelected(r); setTab('values'); } },
              { icon: 'manifest', label: 'Manifest', onSelect: () => { setSelected(r); setTab('manifest'); } },
            ]}
            getRowTone={(r) => (statusTone('helm', r.status) === 'bad' ? 'bad' : undefined)}
            loading={loading}
            refetching={refetching}
            emptyState={<EmptyState icon="helm" title="No Helm releases found" hint="Releases installed with Helm 3 appear here." />}
            initialSort={{ key: 'name', dir: 'asc' }}
            storageKey="helm"
          />
        )}
      </div>

      {selected && (
        <div className="bottom-panel">
          <div className="bottom-panel-tabs" role="tablist" aria-label={`${selected.name} details`}>
            {TABS.map((t, idx) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                id={`${uid}-tab-${t.key}`}
                data-tab={t.key}
                aria-selected={tab === t.key}
                aria-controls={`${uid}-panel`}
                tabIndex={tab === t.key ? 0 : -1}
                className={`bottom-tab${tab === t.key ? ' active' : ''}`}
                onClick={() => setTab(t.key)}
                onKeyDown={(e) => onTabKey(e, idx)}
              >
                <Icon name={t.icon} size={15} /> {t.label}
              </button>
            ))}
            <Button variant="ghost" size="sm" iconOnly icon="close" ariaLabel={`Close ${selected.name} details`} className="bottom-panel-toggle" onClick={() => setSelected(null)} />
          </div>
          <div className="bottom-panel-content" id={`${uid}-panel`} role="tabpanel" aria-labelledby={`${uid}-tab-${tab}`}>
            <div className="yaml-viewer">
              <div className="yaml-content" aria-busy={detail.loading || undefined}>
                {detail.loading ? (
                  <div className="yaml-loading"><Skeleton rows={10} cols={2} label={`Loading ${tab}`} /></div>
                ) : detail.error ? (
                  <ErrorState error={detail.error} title={`Couldn't load ${tab}`} onRetry={detail.refetch} />
                ) : (
                  <HighlightedCode code={detail.data?.yaml || ''} lang="yaml" className="yaml-code" />
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
