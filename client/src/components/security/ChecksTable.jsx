import { useMemo } from 'react';
import DataTable from '../ui/DataTable';
import EmptyState from '../ui/EmptyState';
import { sevTotal, SevMini } from './severity';

const checkKey = (r) => `${r.kind}/${r.namespace || ''}/${r.name}`;

/** Resources (config-audit) and Roles (RBAC assessment) tabs. */
export default function ChecksTable({ data, ns, q = '', onSelect, selected, label, loading, refetching }) {
  const ql = q.toLowerCase();
  const rows = useMemo(() => (data?.resources || [])
    .filter((r) => !ns || ns === 'all' || r.namespace === ns)
    .filter((r) => !ql || (r.name || '').toLowerCase().includes(ql) || (r.checks || []).some((c) => (c.id + c.title).toLowerCase().includes(ql))),
  [data, ns, ql]);

  return (
    <DataTable
      caption={label === 'role' ? 'RBAC risk findings' : 'Resource best-practice findings'}
      columns={[
        { key: 'name', header: label === 'role' ? 'Role Name' : 'Name', sortable: true, ellipsis: true, width: 320, render: (r) => <span className="sec-strong">{r.name}</span> },
        { key: 'kind', header: 'Kind', sortable: true, render: (r) => <span className="sec-kind">{r.kind}</span> },
        { key: 'namespace', header: 'Namespace', sortable: true, render: (r) => <span className="sec-dim">{r.namespace || '—'}</span> },
        { key: 'summary', header: 'Vulnerabilities', sortable: true, accessor: (r) => sevTotal(r.summary), render: (r) => <SevMini summary={r.summary} /> },
      ]}
      rows={rows}
      rowKey={checkKey}
      rowName={(r) => `${r.kind} ${r.name}`}
      activeKey={selected ? checkKey(selected) : null}
      onRowActivate={onSelect}
      loading={loading}
      refetching={refetching}
      emptyState={<EmptyState icon="shieldCheck" title={`No ${label} issues${q ? ' match your search' : ''}.`} />}
      initialSort={{ key: 'summary', dir: 'desc' }}
      storageKey={`security-${label}`}
      className="sec-dt"
    />
  );
}

export { ChecksTable, checkKey };
