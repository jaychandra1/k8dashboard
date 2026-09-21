import Icon from '../Icons';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import DataTable from '../ui/DataTable';
import EmptyState from '../ui/EmptyState';
import SearchBox from '../ui/SearchBox';
import Tooltip from '../ui/Tooltip';
import { formatAge } from '../../lib/format';
import { SYNC_ORDER, HEALTH_ORDER, syncTone, healthTone, shortRepo, appKey } from './status';

const COLUMNS = [
  { key: 'name', header: 'Name', sortable: true, ellipsis: true, width: 260, render: (a) => (
    <span className="resource-name-cell"><Icon name="argocd" size={14} className="rn-icon" /><span className="rn-text">{a.name}</span></span>
  ) },
  { key: 'project', header: 'Project', sortable: true },
  { key: 'syncStatus', header: 'Sync', sortable: true, render: (a) => <Badge tone={syncTone(a.syncStatus)}>{a.syncStatus}</Badge> },
  { key: 'healthStatus', header: 'Health', sortable: true, render: (a) => <Badge tone={healthTone(a.healthStatus)}>{a.healthStatus}</Badge> },
  { key: 'destination', header: 'Destination', sortable: true, accessor: (a) => a.destNamespace || a.destName || '', render: (a) => a.destNamespace || a.destName || '-' },
  { key: 'repoURL', header: 'Repository', sortable: true, ellipsis: true, width: 240, className: 'argo-repo',
    accessor: (a) => (a.multiSource ? '(multi-source)' : shortRepo(a.repoURL)),
    render: (a) => (a.multiSource ? '(multi-source)' : shortRepo(a.repoURL) || '-'),
    title: (a) => a.repoURL || '' },
  { key: 'revision', header: 'Revision', mono: true, render: (a) => a.revision || '-' },
  { key: 'age', header: 'Age', sortable: true, accessor: (a) => Date.parse(a.createdAt) || 0, render: (a) => formatAge(a.createdAt), align: 'right', mono: true },
];

/**
 * Applications tab: search + sync/health filter chips, the sortable table with
 * labelled selection checkboxes, and the floating bulk bar.
 */
export default function AppsTable({
  apps = [], filtered = [], counts,
  search, onSearch, syncFilter, onSyncFilter, healthFilter, onHealthFilter,
  selectedKeys, onToggleSelect, onToggleAll, onClearSelection,
  activeKey, onActivate, rowActions,
  loading, refetching,
  onBulkSync, onBulkRefresh, busy,
}) {
  return (
    <>
      <div className="resource-header argo-sub-header">
        <div><span className="resource-count" role="status">{filtered.length}{filtered.length !== apps.length ? ` of ${apps.length}` : ''} applications</span></div>
        <div className="resource-controls">
          <SearchBox value={search} onChange={onSearch} ariaLabel="Search applications" placeholder="Search applications…" />
        </div>
      </div>
      <div className="argo-filterbar" role="group" aria-label="Filter applications">
        <span className="argo-filter-label" id="argo-filter-sync">Sync</span>
        {SYNC_ORDER.filter((s) => counts.sync[s]).map((s) => (
          <button
            key={s} type="button"
            className={`argo-chip ${syncTone(s)} ${syncFilter === s ? 'active' : ''}`}
            aria-pressed={syncFilter === s}
            aria-describedby="argo-filter-sync"
            onClick={() => onSyncFilter(syncFilter === s ? null : s)}
          >
            {s}<b>{counts.sync[s]}</b>
          </button>
        ))}
        <span className="argo-filter-label" id="argo-filter-health">Health</span>
        {HEALTH_ORDER.filter((h) => counts.health[h]).map((h) => (
          <button
            key={h} type="button"
            className={`argo-chip ${healthTone(h)} ${healthFilter === h ? 'active' : ''}`}
            aria-pressed={healthFilter === h}
            aria-describedby="argo-filter-health"
            onClick={() => onHealthFilter(healthFilter === h ? null : h)}
          >
            {h}<b>{counts.health[h]}</b>
          </button>
        ))}
      </div>

      <DataTable
        caption="Argo CD applications"
        columns={COLUMNS}
        rows={filtered}
        rowKey={appKey}
        rowName={(a) => a.name}
        activeKey={activeKey}
        onRowActivate={onActivate}
        rowActions={rowActions}
        selected={selectedKeys}
        onToggleSelect={onToggleSelect}
        onToggleAll={onToggleAll}
        getRowTone={(a) => (healthTone(a.healthStatus) === 'bad' ? 'bad' : undefined)}
        loading={loading}
        refetching={refetching}
        emptyState={<EmptyState icon="argocd" title="No applications match" hint={search || syncFilter || healthFilter ? 'Try clearing the search or filters' : undefined} />}
        initialSort={{ key: 'name', dir: 'asc' }}
        storageKey="argocd-apps"
      />

      {selectedKeys.size > 0 && (
        <div className="bulk-bar" role="toolbar" aria-label="Bulk actions">
          <span className="bulk-count" role="status">{selectedKeys.size} selected</span>
          <button type="button" className="bulk-btn" disabled={busy} onClick={onBulkSync}><Icon name="argocd" size={14} /> Sync</button>
          <button type="button" className="bulk-btn" disabled={busy} onClick={onBulkRefresh}><Icon name="refresh" size={14} /> Refresh</button>
          <Tooltip content="Clear selection">
            <Button variant="ghost" size="sm" iconOnly icon="close" ariaLabel="Clear selection" onClick={onClearSelection} />
          </Tooltip>
        </div>
      )}
    </>
  );
}

export { AppsTable, COLUMNS as APP_COLUMNS };
