import Icon from '../Icons';
import Badge from '../ui/Badge';
import DataTable from '../ui/DataTable';
import EmptyState from '../ui/EmptyState';
import ErrorState from '../ui/ErrorState';
import { formatAge } from '../../lib/format';
import { errorTitle } from '../shared/errors';

const nameCell = (icon) =>
  function NameCell(r) {
    return (
      <span className="resource-name-cell"><Icon name={icon} size={14} className="rn-icon" /><span className="rn-text">{r.name}</span></span>
    );
  };

function Wrap({ req, what, children }) {
  if (req.error && !req.data) {
    return <div className="resource-table-wrapper"><ErrorState error={req.error} title={errorTitle(req.error, what)} onRetry={req.refetch} busy={req.refetching} /></div>;
  }
  return children;
}

export function AppSetsTable({ req, appSets = [], available = true }) {
  if (!available && !req.error) {
    return <div className="resource-table-wrapper"><EmptyState icon="box" title="ApplicationSet controller not installed" hint="The ApplicationSet controller isn't installed on this cluster." /></div>;
  }
  return (
    <Wrap req={req} what="ApplicationSets">
      <DataTable
        caption="Argo CD ApplicationSets"
        columns={[
          { key: 'name', header: 'Name', sortable: true, ellipsis: true, width: 260, render: nameCell('box') },
          { key: 'namespace', header: 'Namespace', sortable: true },
          { key: 'generators', header: 'Generators', accessor: (s) => (s.generators || []).join(', '), render: (s) => (s.generators || []).join(', ') || '-' },
          { key: 'project', header: 'Project', sortable: true, render: (s) => s.project || '-' },
          { key: 'destinationNamespace', header: 'Dest. Namespace', sortable: true, render: (s) => s.destinationNamespace || '-' },
          { key: 'age', header: 'Age', sortable: true, accessor: (s) => Date.parse(s.createdAt) || 0, render: (s) => formatAge(s.createdAt), align: 'right', mono: true },
        ]}
        rows={appSets}
        rowKey={(s) => `${s.namespace}/${s.name}`}
        loading={req.loading} refetching={req.refetching}
        emptyState={<EmptyState icon="box" title="No ApplicationSets" />}
        initialSort={{ key: 'name', dir: 'asc' }} storageKey="argocd-appsets"
      />
    </Wrap>
  );
}

export function ProjectsTable({ req, projects = [] }) {
  return (
    <Wrap req={req} what="AppProjects">
      <DataTable
        caption="Argo CD projects"
        columns={[
          { key: 'name', header: 'Name', sortable: true, ellipsis: true, width: 220, render: nameCell('accessControl') },
          { key: 'description', header: 'Description', ellipsis: true, width: 260, render: (p) => p.description || '-' },
          { key: 'sourceRepos', header: 'Source Repos', ellipsis: true, width: 240, className: 'argo-repo', accessor: (p) => (p.sourceRepos || []).join(', '), render: (p) => (p.sourceRepos || []).join(', ') || '-' },
          { key: 'destinations', header: 'Destinations', accessor: (p) => (p.destinations || []).length,
            render: (p) => (p.destinations?.length ? p.destinations.slice(0, 2).join(', ') + (p.destinations.length > 2 ? ` +${p.destinations.length - 2}` : '') : '-') },
          { key: 'roles', header: 'Roles', sortable: true, accessor: (p) => (p.roles || []).length, render: (p) => (p.roles || []).length || '-', align: 'right' },
          { key: 'age', header: 'Age', sortable: true, accessor: (p) => Date.parse(p.createdAt) || 0, render: (p) => formatAge(p.createdAt), align: 'right', mono: true },
        ]}
        rows={projects}
        rowKey={(p) => p.name}
        loading={req.loading} refetching={req.refetching}
        emptyState={<EmptyState icon="accessControl" title="No AppProjects" />}
        initialSort={{ key: 'name', dir: 'asc' }} storageKey="argocd-projects"
      />
    </Wrap>
  );
}

export function RepositoriesTable({ req, repositories = [] }) {
  return (
    <Wrap req={req} what="repositories">
      <DataTable
        caption="Argo CD repositories"
        columns={[
          { key: 'url', header: 'Repository', sortable: true, ellipsis: true, width: 380, render: (r) => (
            <a className="xlink" href={r.url.startsWith('http') ? r.url : `https://${r.url}`} target="_blank" rel="noreferrer">{r.url}</a>
          ) },
          { key: 'type', header: 'Type', sortable: true, render: (r) => <Badge tone="muted" dot={false}>{r.type}</Badge> },
          { key: 'appCount', header: 'Applications', sortable: true, accessor: (r) => r.appCount || 0, render: (r) => r.appCount || (r.source === 'secret' ? '—' : 0), align: 'right' },
          { key: 'source', header: 'Source', sortable: true, render: (r) => <span className="drawer-dim">{r.source === 'secret' ? 'configured' : 'from applications'}</span> },
        ]}
        rows={repositories}
        rowKey={(r) => `${r.source || ''}|${r.url}`}
        rowName={(r) => r.url}
        loading={req.loading} refetching={req.refetching}
        emptyState={<EmptyState icon="git" title="No repositories" />}
        initialSort={{ key: 'url', dir: 'asc' }} storageKey="argocd-repos"
      />
    </Wrap>
  );
}

export function ClustersTable({ req, clusters = [] }) {
  return (
    <Wrap req={req} what="clusters">
      <DataTable
        caption="Argo CD clusters"
        columns={[
          { key: 'name', header: 'Name', sortable: true, accessor: (c) => c.name || '(in-cluster)', render: (c) => nameCell('cluster')({ name: c.name || '(in-cluster)' }) },
          { key: 'server', header: 'Server', sortable: true, mono: true, ellipsis: true, width: 420 },
        ]}
        rows={clusters}
        rowKey={(c) => `${c.server}|${c.name || ''}`}
        rowName={(c) => c.name || c.server}
        loading={req.loading} refetching={req.refetching}
        emptyState={<EmptyState icon="cluster" title="No clusters registered" />}
        initialSort={{ key: 'name', dir: 'asc' }} storageKey="argocd-clusters"
      />
    </Wrap>
  );
}
