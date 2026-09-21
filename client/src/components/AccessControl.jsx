import { useId, useMemo, useState } from 'react';
import Icon from './Icons';
import ResourceDrawer from './ResourceDrawer';
import YamlViewer from './YamlViewer';
import DataTable from './ui/DataTable';
import SearchBox from './ui/SearchBox';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import ErrorState from './ui/ErrorState';
import useRequest from '../hooks/useRequest';
import useDocumentTitle from '../hooks/useDocumentTitle';
import { getJson, p } from '../lib/api';
import { formatAge, pluralize } from '../lib/format';
import { XLink, nsLink } from './resources/links';

const TABS = [
  { key: 'serviceAccounts', label: 'Service Accounts', kind: 'ServiceAccount', rt: 'serviceAccount', cols: ['name', 'namespace', 'secrets', 'age'] },
  { key: 'roles', label: 'Roles', kind: 'Role', rt: 'role', cols: ['name', 'namespace', 'rules', 'age'] },
  { key: 'roleBindings', label: 'Role Bindings', kind: 'RoleBinding', rt: 'roleBinding', cols: ['name', 'namespace', 'roleRef', 'subjects', 'age'] },
  { key: 'clusterRoles', label: 'Cluster Roles', kind: 'ClusterRole', rt: 'clusterRole', cols: ['name', 'rules', 'age'] },
  { key: 'clusterRoleBindings', label: 'Cluster Role Bindings', kind: 'ClusterRoleBinding', rt: 'clusterRoleBinding', cols: ['name', 'roleRef', 'subjects', 'age'] },
];

const rowKey = (r) => `${r.namespace || ''}/${r.name}`;

export default function AccessControl({ refreshSignal = 0, onNavigate }) {
  useDocumentTitle('Access Control');
  const uid = useId();
  const [tab, setTab] = useState('serviceAccounts');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null); // { name, namespace, kind, resourceType }
  const [yamlTarget, setYamlTarget] = useState(null);

  const { data, error, loading, refetching, refetch } = useRequest(
    ({ signal }) => getJson(p('api', 'rbac'), { signal }),
    { deps: [refreshSignal], dedupeKey: 'rbac' },
  );

  const active = TABS.find((t) => t.key === tab) || TABS[0];
  const items = useMemo(() => {
    const list = data?.[tab] || [];
    const needle = search.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((r) => r.name.toLowerCase().includes(needle) || (r.namespace || '').toLowerCase().includes(needle));
  }, [data, tab, search]);
  const partialErrors = data?.partial ? (data.errors || []) : [];

  const ALL_COLUMNS = useMemo(() => ({
    name: {
      key: 'name', header: 'Name', sortable: true, ellipsis: true, width: 300,
      render: (r) => <span className="resource-name-cell"><Icon name="accessControl" size={15} className="rn-icon" /><span className="rn-text">{r.name}</span></span>,
      title: (r) => r.name,
    },
    namespace: {
      key: 'namespace', header: 'Namespace', sortable: true, ellipsis: true, width: 170,
      render: (r) => (r.namespace && r.namespace !== '-'
        ? <XLink link={nsLink(r.namespace)} onNavigate={onNavigate} title={`Filter to ${r.namespace}`}>{r.namespace}</XLink>
        : <span className="drawer-dim">cluster</span>),
      title: (r) => r.namespace,
    },
    secrets: { key: 'secrets', header: 'Secrets', sortable: true, align: 'right', mono: true, width: 90, accessor: (r) => r.secrets ?? 0, render: (r) => r.secrets ?? 0 },
    rules: { key: 'rules', header: 'Rules', sortable: true, align: 'right', mono: true, width: 80, accessor: (r) => r.rules ?? 0, render: (r) => r.rules ?? 0 },
    subjects: { key: 'subjects', header: 'Subjects', sortable: true, align: 'right', mono: true, width: 90, accessor: (r) => r.subjects ?? 0, render: (r) => r.subjects ?? 0 },
    roleRef: { key: 'roleRef', header: 'Role', sortable: true, ellipsis: true, width: 220, render: (r) => r.roleRef || '—', title: (r) => r.roleRef },
    age: { key: 'age', header: 'Age', sortable: true, align: 'right', mono: true, width: 80, accessor: (r) => (r.createdAt ? Date.parse(r.createdAt) : null), render: (r) => formatAge(r.createdAt) },
  }), [onNavigate]);
  const columns = useMemo(() => active.cols.map((c) => ALL_COLUMNS[c]), [active, ALL_COLUMNS]);

  const select = (r) => setSelected({ name: r.name, namespace: r.namespace && r.namespace !== '-' ? r.namespace : '', kind: active.kind, resourceType: active.rt });
  const selectTab = (key) => { setTab(key); setSelected(null); };
  const onTabKey = (e, idx) => {
    let next = null;
    if (e.key === 'ArrowRight') next = (idx + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next == null) return;
    e.preventDefault();
    selectTab(TABS[next].key);
    e.currentTarget.parentElement?.querySelector(`[data-tab="${TABS[next].key}"]`)?.focus();
  };

  return (
    <div className="resource-viewer">
      <div className="resource-tabs" role="tablist" aria-label="Access control kinds">
        {TABS.map((t, idx) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`${uid}-tab-${t.key}`}
            data-tab={t.key}
            aria-selected={tab === t.key}
            tabIndex={tab === t.key ? 0 : -1}
            className={`resource-tab${tab === t.key ? ' active' : ''}`}
            onClick={() => selectTab(t.key)}
            onKeyDown={(e) => onTabKey(e, idx)}
          >
            <Icon name="accessControl" size={15} />
            {t.label}
          </button>
        ))}
      </div>

      <div className="resource-header">
        <div>
          <h1 className="resource-title"><Icon name="accessControl" size={18} /> {active.label}</h1>
          <span className="resource-count">{items.length} {pluralize(items.length, 'item')}</span>
          <span className="resource-refreshing" aria-live="polite" role="status">{refetching ? 'Refreshing…' : ''}</span>
        </div>
        <div className="resource-controls">
          <SearchBox value={search} onChange={setSearch} ariaLabel={`Search ${active.label}`} placeholder="Search…" shortcut="/" />
        </div>
      </div>

      {partialErrors.length > 0 && (
        <div className="partial-banner" role="status">
          <Icon name="warning" size={14} />
          <span>Some kinds could not be loaded: {partialErrors.map((e) => `${e.kind}${e.error ? ` (${e.error})` : ''}`).join('; ')}</span>
        </div>
      )}

      <div className="resource-table-wrapper" role="tabpanel" aria-labelledby={`${uid}-tab-${tab}`}>
        {error && !data ? (
          <ErrorState error={error} title="Couldn't load access control" onRetry={refetch} busy={refetching} />
        ) : (
          <DataTable
            caption={active.label}
            columns={columns}
            rows={items}
            rowKey={rowKey}
            rowName={(r) => r.name}
            activeKey={selected ? `${selected.namespace || ''}/${selected.name}` : null}
            onRowActivate={select}
            rowActions={(r) => [
              { icon: 'details', label: 'Details', onSelect: () => select(r) },
              { icon: 'configuration', label: 'View YAML', onSelect: () => setYamlTarget({ name: r.name, namespace: r.namespace && r.namespace !== '-' ? r.namespace : '', resourceType: active.rt }) },
            ]}
            loading={loading}
            refetching={refetching}
            emptyState={<EmptyState icon="accessControl" title={`No ${active.label.toLowerCase()} found`} hint={search ? `Nothing matches “${search}”.` : undefined} />}
            initialSort={{ key: 'name', dir: 'asc' }}
            storageKey={`rbac:${tab}`}
          />
        )}
      </div>

      {yamlTarget && (
        <div className="bottom-panel">
          <div className="bottom-panel-tabs" role="tablist" aria-label="Open panels">
            <button type="button" role="tab" aria-selected="true" className="bottom-tab active"><Icon name="configuration" size={15} /> YAML · {yamlTarget.name}</button>
            <Button variant="ghost" size="sm" iconOnly icon="close" ariaLabel={`Close YAML for ${yamlTarget.name}`} className="bottom-panel-toggle" onClick={() => setYamlTarget(null)} />
          </div>
          <div className="bottom-panel-content" role="tabpanel">
            <YamlViewer namespace={yamlTarget.namespace} kind={yamlTarget.resourceType} name={yamlTarget.name} onClose={() => setYamlTarget(null)} onApplied={refetch} />
          </div>
        </div>
      )}

      {selected && (
        <ResourceDrawer
          resource={selected}
          namespace={selected.namespace}
          resourceType={selected.resourceType}
          onClose={() => setSelected(null)}
          onOpenYaml={(r) => setYamlTarget({ name: r.name, namespace: r.namespace || '', resourceType: r.resourceType })}
          onNavigate={onNavigate}
          refreshSignal={refreshSignal}
        />
      )}
    </div>
  );
}
