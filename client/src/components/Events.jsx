import { useMemo } from 'react';
import Icon from './Icons';
import DataTable from './ui/DataTable';
import Badge from './ui/Badge';
import EmptyState from './ui/EmptyState';
import ErrorState from './ui/ErrorState';
import useRequest from '../hooks/useRequest';
import { getJson, p } from '../lib/api';
import { formatAgeSeconds, pluralize } from '../lib/format';
import { byApiKind } from '../lib/kinds';
import { XLink, nsLink, resourceLink } from './resources/links';

// "Kind/name" → a link to the involved object's list view (when we have one).
const objectLink = (involved, namespace) => {
  const [kind, ...rest] = String(involved || '').split('/');
  const name = rest.join('/');
  const type = byApiKind[kind];
  return type && name ? resourceLink(type, namespace, name) : null;
};

const eventKey = (e, i) => `${e.namespace || ''}|${e.involvedObject || ''}|${e.reason || ''}|${e.firstTimestamp || ''}|${e.lastTimestamp || ''}|${i}`;

export default function Events({ namespace = 'all', refreshSignal = 0, onNavigate }) {
  const ns = namespace || 'all';
  const { data, error, loading, refetching, refetch } = useRequest(
    ({ signal }) => getJson(p('api', 'events', ns), { signal }),
    { deps: [ns, refreshSignal], dedupeKey: `events:${ns}` },
  );
  const events = data?.events || [];

  const columns = useMemo(() => [
    { key: 'message', header: 'Message', ellipsis: true, maxWidth: 480, className: 'event-message', render: (e) => e.message || '—', title: (e) => e.message },
    { key: 'namespace', header: 'Namespace', sortable: true, ellipsis: true, width: 150, render: (e) => (e.namespace ? <XLink link={nsLink(e.namespace)} onNavigate={onNavigate} title={`Filter to ${e.namespace}`}>{e.namespace}</XLink> : '—'), title: (e) => e.namespace },
    { key: 'type', header: 'Type', sortable: true, width: 110, render: (e) => <Badge status={e.type || 'Normal'} kind="event" /> },
    { key: 'reason', header: 'Reason', sortable: true, width: 160, ellipsis: true, render: (e) => e.reason || '—', title: (e) => e.reason },
    {
      key: 'involvedObject', header: 'Object', sortable: true, ellipsis: true, width: 240,
      render: (e) => { const link = objectLink(e.involvedObject, e.namespace); return link ? <XLink link={link} onNavigate={onNavigate} title={`Open ${e.involvedObject}`}>{e.involvedObject}</XLink> : (e.involvedObject || '—'); },
      title: (e) => e.involvedObject,
    },
    { key: 'count', header: 'Count', sortable: true, align: 'right', mono: true, width: 80, accessor: (e) => e.count ?? 0, render: (e) => e.count ?? '—' },
    { key: 'age', header: 'Age', sortable: true, align: 'right', mono: true, width: 80, accessor: (e) => (e.age == null ? null : e.age), render: (e) => (e.age == null ? '—' : formatAgeSeconds(e.age)) },
  ], [onNavigate]);

  return (
    <div className="events-container">
      <div className="events-toolbar">
        <h2>Cluster Events</h2>
        <span className="resource-count">{events.length} {pluralize(events.length, 'event')}</span>
        <span className="resource-refreshing" aria-live="polite" role="status">{refetching ? 'Refreshing…' : ''}</span>
        <button type="button" className="events-refresh-btn" onClick={refetch} disabled={refetching} aria-label="Refresh events">
          <Icon name="refresh" size={14} /> Refresh
        </button>
      </div>

      <div className="events-content">
        {error && events.length === 0 ? (
          <ErrorState error={error} title="Couldn't load events" onRetry={refetch} busy={refetching} />
        ) : (
          <>
            {error && <ErrorState compact error={error} title="Latest refresh failed — showing previous events" onRetry={refetch} busy={refetching} />}
            <DataTable
              caption={`Events in ${ns === 'all' ? 'all namespaces' : `namespace ${ns}`}`}
              columns={columns}
              rows={events}
              rowKey={eventKey}
              rowName={(e) => `${e.reason || 'event'} ${e.involvedObject || ''}`}
              getRowTone={(e) => (String(e.type).toLowerCase() === 'warning' ? 'warn' : undefined)}
              loading={loading}
              refetching={refetching}
              emptyState={<EmptyState icon="events" title="No recent events" hint={ns === 'all' ? 'The cluster has not reported any events recently.' : `No events in namespace ${ns}. Try “all namespaces”.`} />}
              className="events-table-wrap"
            />
          </>
        )}
      </div>
    </div>
  );
}
