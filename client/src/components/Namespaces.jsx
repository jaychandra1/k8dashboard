import { useMemo, useState } from 'react';
import Icon from './Icons';
import DataTable from './ui/DataTable';
import { nameRoom } from './ui/tableColumns';
import SearchBox from './ui/SearchBox';
import Badge from './ui/Badge';
import EmptyState from './ui/EmptyState';
import ErrorState from './ui/ErrorState';
import useRequest from '../hooks/useRequest';
import useDocumentTitle from '../hooks/useDocumentTitle';
import { getJson, p, errorMessage } from '../lib/api';
import { formatAge, pluralize } from '../lib/format';
import { statusTone } from '../lib/status';
import { XLink, nsLink, navigateVia } from './resources/links';
import { useToast } from './Toast';
import { useNamespaceAccess, AddNamespaceForm, RESTRICTED_HINT } from './shell/NamespaceAccess';

export default function Namespaces({ onSelectNamespace, refreshSignal = 0, onNavigate }) {
  useDocumentTitle('Namespaces');
  const [search, setSearch] = useState('');
  const { data, error, loading, refetching, refetch } = useRequest(
    ({ signal }) => getJson(p('api', 'namespaces'), { signal }),
    { deps: [refreshSignal], dedupeKey: 'namespaces:list' },
  );
  // A user who may not list namespaces sees the ones they added (and can add
  // or remove them here): that list lives in the shell, not in this request.
  const access = useNamespaceAccess();
  const toast = useToast();
  const restricted = access.restricted || data?.restricted === true;
  const items = useMemo(
    () => (restricted
      ? access.namespaces.map((n) => ({ name: n, status: 'Active' }))
      : data?.details || (data?.namespaces || []).map((n) => ({ name: n, status: 'Active' }))),
    [data, restricted, access.namespaces],
  );
  const removeFromList = restricted && access.remove
    ? (ns) => [{
      label: 'Remove from my namespaces',
      icon: 'delete',
      onSelect: () => access.remove(ns.name).catch((e) => toast.error(errorMessage(e, 'The namespace could not be removed.'), { title: 'Namespaces' })),
    }]
    : undefined;
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return needle ? items.filter((n) => n.name.toLowerCase().includes(needle)) : items;
  }, [items, search]);

  const select = (ns) => {
    if (onSelectNamespace) onSelectNamespace(ns);
    else navigateVia(onNavigate, nsLink(ns.name));
  };

  const columns = useMemo(() => [
    {
      key: 'name', header: 'Name', sortable: true, ellipsis: true, width: 300, maxWidth: 460, fit: nameRoom,
      render: (ns) => (
        <XLink
          className="xlink resource-name-cell"
          link={nsLink(ns.name)}
          onNavigate={onSelectNamespace ? () => onSelectNamespace(ns) : onNavigate}
          title={`View ${ns.name} workloads`}
        >
          <Icon name="namespace" size={15} className="rn-icon" />
          <span className="rn-text">{ns.name}</span>
        </XLink>
      ),
      title: (ns) => ns.name,
    },
    { key: 'status', header: 'Status', sortable: true, width: 130, accessor: (ns) => ns.status || 'Active', render: (ns) => <Badge status={ns.status || 'Active'} kind="namespace" /> },
    {
      // The labels take the room the other columns leave, on one line; the tooltip has them all.
      key: 'labels', header: 'Labels', width: 320, fill: true, accessor: (ns) => Object.keys(ns.labels || {}).length,
      title: (ns) => Object.entries(ns.labels || {}).map(([k, v]) => (v ? `${k}=${v}` : k)).join(', ') || undefined,
      render: (ns) => {
        const entries = Object.entries(ns.labels || {});
        if (!entries.length) return '—';
        return (
          <span className="drawer-chips">
            {entries.slice(0, 3).map(([k, v]) => <span key={k} className="drawer-chip">{k}{v ? `=${v}` : ''}</span>)}
            {entries.length > 3 && <span className="drawer-chip muted">+{entries.length - 3}</span>}
          </span>
        );
      },
    },
    { key: 'age', header: 'Age', sortable: true, align: 'right', mono: true, width: 80, accessor: (ns) => (ns.createdAt ? Date.parse(ns.createdAt) : null), render: (ns) => formatAge(ns.createdAt) },
  ], [onSelectNamespace, onNavigate]);

  return (
    <div className="resource-viewer">
      <div className="resource-header">
        <div>
          <h1 className="resource-title">
            <Icon name="namespace" size={18} />
            Namespaces
          </h1>
          <span className="resource-count">{filtered.length} {pluralize(filtered.length, 'item')}</span>
          <span className="resource-refreshing" aria-live="polite" role="status">{refetching ? 'Refreshing…' : ''}</span>
        </div>
        <div className="resource-controls">
          <SearchBox value={search} onChange={setSearch} ariaLabel="Search namespaces" placeholder="Search namespaces…" shortcut="/" />
        </div>
      </div>

      {restricted && (
        <div className="ns-restricted-bar">
          <Icon name="shield" size={15} />
          <span>{RESTRICTED_HINT}</span>
          <AddNamespaceForm compact />
        </div>
      )}

      <div className="resource-table-wrapper">
        {error && items.length === 0 && !restricted ? (
          <ErrorState error={error} title="Couldn't load namespaces" onRetry={refetch} busy={refetching} />
        ) : (
          <DataTable
            caption="Namespaces"
            columns={columns}
            rows={filtered}
            rowKey={(ns) => ns.name}
            rowName={(ns) => ns.name}
            onRowActivate={select}
            rowActions={removeFromList}
            getRowTone={(ns) => (statusTone('namespace', ns.status) === 'bad' ? 'bad' : undefined)}
            loading={loading}
            refetching={refetching}
            emptyState={<EmptyState icon="namespace" title={restricted && !search ? 'No namespaces added yet' : 'No namespaces found'} hint={search ? `Nothing matches “${search}”.` : restricted ? 'Add the namespace you were given access to, above.' : 'The cluster reported no namespaces.'} />}
            initialSort={{ key: 'name', dir: 'asc' }}
            storageKey="namespaces"
          />
        )}
      </div>
    </div>
  );
}
