import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Icon from './Icons';
import DataTable from './ui/DataTable';
import Badge from './ui/Badge';
import Button from './ui/Button';
import BottomPanel, { PanelFullscreenToggle } from './ui/BottomPanel';
import EmptyState from './ui/EmptyState';
import ErrorState from './ui/ErrorState';
import Skeleton from './ui/Skeleton';
import HighlightedCode from './ui/HighlightedCode';
import TerminalViewer from './TerminalViewer';
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

const TERMINAL_TAB = { key: 'terminal', label: 'Helm terminal', icon: 'terminal' };

const releaseKey = (r) => `${r.namespace}/${r.name}`;
const clusterLabel = (ctx) => String(ctx || '').split('/').pop();

export default function Helm({ refreshSignal = 0, onNavigate }) {
  useDocumentTitle('Helm');
  const uid = useId();
  const [selected, setSelected] = useState(null); // release
  const [tab, setTab] = useState('values');
  // "+ Helm terminal": a shell where helm/kubectl reach only the current
  // cluster (server: lib/helm-shell.mjs). { key } while open; a new key = a new session.
  const [terminal, setTerminal] = useState(null);

  const { data, error, loading, refetching, refetch } = useRequest(
    ({ signal }) => getJson(p('api', 'helm', 'releases'), { signal }),
    { deps: [refreshSignal], dedupeKey: 'helm:releases' },
  );
  const releases = data?.releases || [];

  // Desktop app only (a shell on the user's own machine); hidden elsewhere.
  const termInfo = useRequest(
    ({ signal }) => getJson(p('api', 'helm-terminal'), { signal }),
    { deps: [refreshSignal], dedupeKey: 'helm:terminal' },
  );
  const canTerminal = !!termInfo.data?.available;
  const cluster = clusterLabel(termInfo.data?.context);

  // Tabs in the bottom panel: the selected release's, then the terminal's.
  const tabs = useMemo(() => [...(selected ? TABS : []), ...(terminal ? [TERMINAL_TAB] : [])], [selected, terminal]);
  const activeTab = tabs.some((t) => t.key === tab) ? tab : tabs[0]?.key;

  const openTerminal = () => { setTerminal((cur) => cur || { key: Date.now() }); setTab('terminal'); };
  const closeTerminal = () => { setTerminal(null); setTab('values'); };
  const closePanel = () => { setSelected(null); setTerminal(null); };

  // A command typed in the terminal (helm install / upgrade / uninstall) shows
  // up in the table: refresh shortly after Enter, and again for slower installs.
  const refreshTimers = useRef([]);
  const onTerminalCommand = useCallback(() => {
    refreshTimers.current.forEach(clearTimeout);
    refreshTimers.current = [setTimeout(refetch, 3000), setTimeout(refetch, 15000)];
  }, [refetch]);
  useEffect(() => () => refreshTimers.current.forEach(clearTimeout), []);

  // Values / manifest keyed by (release, tab): a stale response can never land
  // on the wrong tab because useRequest aborts + ignores superseded runs.
  const detail = useRequest(
    ({ signal }) => getJson(p('api', 'helm', 'releases', selected.namespace, selected.name, tab), { signal }),
    { deps: [selected?.namespace, selected?.name, tab, refreshSignal], enabled: !!selected && tab !== 'terminal', keepPreviousData: false, dedupeKey: selected ? `helm:${selected.namespace}/${selected.name}/${tab}` : undefined },
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
    if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next == null) return;
    e.preventDefault();
    setTab(tabs[next].key);
    e.currentTarget.closest('[role="tablist"]')?.querySelector(`[data-tab="${tabs[next].key}"]`)?.focus();
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
        <div className="resource-controls">
          {canTerminal && (
            <Button
              variant="primary"
              icon="plus"
              onClick={openTerminal}
              title={`Open a terminal where helm and kubectl run against ${cluster || 'the current cluster'} only`}
            >
              Helm terminal
            </Button>
          )}
        </div>
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

      {(selected || terminal) && (
        <BottomPanel>
          <div className="bottom-panel-tabs" role="tablist" aria-label={selected ? `${selected.name} details` : 'Helm terminal'}>
            {tabs.map((t, idx) => (
              <span key={t.key} className="bottom-tab-group">
                <button
                  type="button"
                  role="tab"
                  id={`${uid}-tab-${t.key}`}
                  data-tab={t.key}
                  aria-selected={activeTab === t.key}
                  aria-controls={`${uid}-panel`}
                  tabIndex={activeTab === t.key ? 0 : -1}
                  className={`bottom-tab${activeTab === t.key ? ' active' : ''}`}
                  onClick={() => setTab(t.key)}
                  onKeyDown={(e) => onTabKey(e, idx)}
                >
                  <Icon name={t.icon} size={15} /> {t.key === 'terminal' && cluster ? `${t.label} · ${cluster}` : t.label}
                </button>
                {t.key === 'terminal' && (
                  <button type="button" className="tab-chip-close" aria-label="Close Helm terminal" onClick={closeTerminal}>
                    <Icon name="close" size={12} />
                  </button>
                )}
              </span>
            ))}
            <PanelFullscreenToggle label={activeTab === 'terminal' ? 'Helm terminal' : 'details'} />
            <Button
              variant="ghost" size="sm" iconOnly icon="close"
              ariaLabel={selected && terminal ? 'Close panel' : selected ? `Close ${selected.name} details` : 'Close Helm terminal panel'}
              className="bottom-panel-toggle"
              onClick={closePanel}
            />
          </div>
          <div className="bottom-panel-content" id={`${uid}-panel`} role="tabpanel" aria-labelledby={`${uid}-tab-${activeTab}`}>
            {selected && activeTab !== 'terminal' && (
              <div className="yaml-viewer">
                <div className="yaml-content" aria-busy={detail.loading || undefined}>
                  {detail.loading ? (
                    <div className="yaml-loading"><Skeleton rows={10} cols={2} label={`Loading ${activeTab}`} /></div>
                  ) : detail.error ? (
                    <ErrorState error={detail.error} title={`Couldn't load ${activeTab}`} onRetry={detail.refetch} />
                  ) : (
                    <HighlightedCode code={detail.data?.yaml || ''} lang="yaml" className="yaml-code" />
                  )}
                </div>
              </div>
            )}
            {/* Kept mounted while open so switching tabs doesn't end the session. */}
            {terminal && (
              <div className="tab-pane" hidden={activeTab !== 'terminal'}>
                <TerminalViewer
                  key={terminal.key}
                  wsParams={{ shell: 'helm' }}
                  title={`helm · ${cluster || 'cluster'}`}
                  onClose={closeTerminal}
                  onCommand={onTerminalCommand}
                  onStatus={(s) => { if (s === 'closed') refetch(); }}
                />
              </div>
            )}
          </div>
        </BottomPanel>
      )}
    </div>
  );
}
