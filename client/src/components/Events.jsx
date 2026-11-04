import { useEffect, useMemo, useState } from 'react';
import Icon from './Icons';
import DataTable from './ui/DataTable';
import Badge from './ui/Badge';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import ErrorState from './ui/ErrorState';
import SearchBox from './ui/SearchBox';
import NamespaceMultiSelect from './NamespaceMultiSelect';
import useRequest from '../hooks/useRequest';
import { getJson, p } from '../lib/api';
import { formatAgeSeconds, pluralize } from '../lib/format';
import { byApiKind } from '../lib/kinds';
import { XLink, eventsNsLink, nsLink, resourceLink } from './resources/links';

// "Kind/name" → a link to the involved object's list view (when we have one).
const objectLink = (involved, namespace) => {
  const [kind, ...rest] = String(involved || '').split('/');
  const name = rest.join('/');
  const type = byApiKind[kind];
  return type && name ? resourceLink(type, namespace, name) : null;
};

const eventKey = (e, i) => `${e.namespace || ''}|${e.involvedObject || ''}|${e.reason || ''}|${e.firstTimestamp || ''}|${e.lastTimestamp || ''}|${i}`;

const ALL = 'all';
const PAGE = 100;
// Workloads the filter offers, from /api/resources (Pods come in through
// "View events" on a pod).
const WORKLOAD_GROUPS = [
  ['deployments', 'Deployment', 'Deployments'], ['statefulSets', 'StatefulSet', 'StatefulSets'],
  ['daemonSets', 'DaemonSet', 'DaemonSets'], ['cronJobs', 'CronJob', 'CronJobs'], ['jobs', 'Job', 'Jobs'],
];
const SCOPE_NOTE = {
  Deployment: 'its ReplicaSets and Pods', StatefulSet: 'its Pods and volume claims', DaemonSet: 'its Pods',
  Job: 'its Pods', CronJob: 'its Jobs and their Pods', Pod: 'the Pod',
};

function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/**
 * Cluster events, filtered on the server (before paging): namespace(s), All /
 * Warnings, a search, and one workload — the workload's events include those
 * of what it owns (a Deployment's ReplicaSets and Pods…).
 *
 * Filters are controlled when `onFiltersChange` is given (the Events page
 * keeps them in the URL: type, q, workload); otherwise they're local (the
 * Events tab of the workloads view). The namespace picker shows only with
 * `namespaces` + `onNamespaceChange`.
 */
export default function Events({
  namespace = ALL, selectedNamespaces, namespaces, onNamespaceChange, refreshSignal = 0, onNavigate,
  type: typeProp, search: searchProp, workload: workloadProp, onFiltersChange,
}) {
  const ns = namespace || ALL;
  const single = ns !== ALL ? ns : null;
  const multi = !single && Array.isArray(selectedNamespaces) && selectedNamespaces.length > 1 && !selectedNamespaces.includes(ALL)
    ? selectedNamespaces : null;

  const [local, setLocal] = useState({ type: '', q: '', workload: '' });
  const controlled = typeof onFiltersChange === 'function';
  const type = controlled ? (typeProp || '') : local.type;
  const q = controlled ? (searchProp || '') : local.q;
  const workloadRaw = controlled ? (workloadProp || '') : local.workload;
  // A workload filter only applies to a single namespace.
  const workload = single ? workloadRaw : '';
  const setFilters = (patch) => {
    if (controlled) onFiltersChange(Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v || undefined])));
    else setLocal((s) => ({ ...s, ...patch }));
  };
  const debouncedQ = useDebounced(q.trim());

  // Pages of 100; "Load more" adds one. Back to one page when a filter changes.
  const [pages, setPages] = useState(1);
  const filterKey = `${ns}|${multi?.join(',') || ''}|${type}|${debouncedQ}|${workload}`;
  useEffect(() => { setPages(1); }, [filterKey]);

  const { data, error, loading, refetching, refetch } = useRequest(
    async ({ signal }) => {
      const params = {
        limit: PAGE, type: type || undefined, q: debouncedQ || undefined,
        workload: workload || undefined, namespaces: multi ? multi.join(',') : undefined,
      };
      let out = null;
      for (let page = 1; page <= pages; page++) {
        const r = await getJson(p('api', 'events', ns), { signal, params: { ...params, page } });
        out = out ? { ...r, events: [...out.events, ...(r.events || [])] } : { ...r, events: r.events || [] };
        if (page >= (r.pagination?.pages || 1)) break;
      }
      return out;
    },
    { deps: [filterKey, pages, refreshSignal], dedupeKey: `events:${filterKey}:${pages}` },
  );
  const events = data?.events || [];
  const total = data?.pagination?.total ?? events.length;
  const unfiltered = data?.unfiltered ?? total;
  const filtered = !!(type || debouncedQ || workload);

  // Workloads of the selected namespace, for the picker.
  const { data: res } = useRequest(
    ({ signal }) => getJson(p('api', 'resources', single), { signal }),
    { deps: [single, refreshSignal], enabled: !!single, dedupeKey: `events-workloads:${single}` },
  );
  const workloadOptions = useMemo(() => WORKLOAD_GROUPS
    .map(([key, kind, label]) => ({ kind, label, names: (res?.[key] || []).map((r) => r.name).sort() }))
    .filter((g) => g.names.length), [res]);
  const workloadKnown = workloadOptions.some((g) => g.names.some((n) => `${g.kind}/${n}` === workload));
  const [wKind, ...wRest] = workload.split('/');
  const wName = wRest.join('/');

  const columns = useMemo(() => [
    // Message takes the width the fixed columns leave (and wraps), so Count
    // and Age stay on screen at 1280px.
    { key: 'message', header: 'Message', minWidth: 260, className: 'event-message', render: (e) => e.message || '—' },
    { key: 'namespace', header: 'Namespace', sortable: true, ellipsis: true, width: 150, render: (e) => (e.namespace ? <XLink link={onNamespaceChange ? eventsNsLink(e.namespace) : nsLink(e.namespace)} onNavigate={onNavigate} title={`Filter to ${e.namespace}`}>{e.namespace}</XLink> : '—'), title: (e) => e.namespace },
    { key: 'type', header: 'Type', sortable: true, width: 110, render: (e) => <Badge status={e.type || 'Normal'} kind="event" /> },
    { key: 'reason', header: 'Reason', sortable: true, width: 160, ellipsis: true, render: (e) => e.reason || '—', title: (e) => e.reason },
    {
      key: 'involvedObject', header: 'Object', sortable: true, ellipsis: true, width: 200,
      render: (e) => { const link = objectLink(e.involvedObject, e.namespace); return link ? <XLink link={link} onNavigate={onNavigate} title={`Open ${e.involvedObject}`}>{e.involvedObject}</XLink> : (e.involvedObject || '—'); },
      title: (e) => e.involvedObject,
    },
    { key: 'count', header: 'Count', sortable: true, align: 'right', mono: true, width: 80, accessor: (e) => e.count ?? 0, render: (e) => e.count ?? '—' },
    { key: 'age', header: 'Age', sortable: true, align: 'right', mono: true, width: 80, accessor: (e) => (e.age == null ? null : e.age), render: (e) => (e.age == null ? '—' : formatAgeSeconds(e.age)) },
  ], [onNavigate, onNamespaceChange]);

  const nsLabel = single ? `namespace ${single}` : multi ? `${multi.length} namespaces` : 'all namespaces';
  const clearFilters = () => setFilters({ type: '', q: '', workload: '' });
  const changeNamespaces = (next) => {
    // The workload belongs to the namespace it was picked in.
    if (workloadRaw) setFilters({ workload: '' });
    onNamespaceChange(next);
  };

  return (
    <div className="events-container">
      <div className="events-toolbar">
        <div className="events-title">
          <h2><Icon name="events" size={18} /> Cluster Events</h2>
          <span className="resource-count">
            {filtered ? `${total.toLocaleString()} of ${unfiltered.toLocaleString()}` : total.toLocaleString()} {pluralize(filtered ? unfiltered : total, 'event')}
          </span>
        </div>
        <span className="resource-refreshing" aria-live="polite" role="status">{refetching ? 'Refreshing…' : ''}</span>
        <button type="button" className="events-refresh-btn" onClick={refetch} disabled={refetching} aria-label="Refresh events">
          <Icon name="refresh" size={14} /> Refresh
        </button>
      </div>

      <div className="events-filters" role="group" aria-label="Filter events">
        {namespaces && onNamespaceChange && (
          <NamespaceMultiSelect namespaces={namespaces} selected={selectedNamespaces || [ns]} onChange={changeNamespaces} />
        )}
        <label className="events-workload">
          <span className="sr-only">Workload</span>
          <select
            className="ui-select"
            value={workload}
            disabled={!single}
            title={single ? undefined : 'Pick a single namespace to filter by workload'}
            onChange={(e) => setFilters({ workload: e.target.value })}
          >
            <option value="">{single ? 'All workloads' : 'Workload: pick a namespace'}</option>
            {workload && !workloadKnown && <option value={workload}>{wKind} {wName}</option>}
            {workloadOptions.map((g) => (
              <optgroup key={g.kind} label={g.label}>
                {g.names.map((n) => <option key={n} value={`${g.kind}/${n}`}>{n}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <div className="events-seg" role="group" aria-label="Event type">
          <button type="button" className={!type ? 'active' : ''} aria-pressed={!type} onClick={() => setFilters({ type: '' })}>All</button>
          <button type="button" className={type === 'Warning' ? 'active' : ''} aria-pressed={type === 'Warning'} onClick={() => setFilters({ type: 'Warning' })}>
            <Icon name="warning" size={13} /> Warnings
          </button>
        </div>
        <SearchBox
          value={q}
          onChange={(v) => setFilters({ q: v })}
          ariaLabel="Search events"
          placeholder="Search events…"
          className="events-search"
        />
        {workload && (
          <span className="events-chip" title={`Events of ${workload} and ${SCOPE_NOTE[wKind] || 'what it owns'}`}>
            <Icon name="filter" size={12} /> {wKind} <b>{wName}</b>
            <span className="events-chip-note">+ {SCOPE_NOTE[wKind] || 'what it owns'}</span>
            <button type="button" aria-label={`Remove the ${wKind} ${wName} filter`} onClick={() => setFilters({ workload: '' })}><Icon name="close" size={12} /></button>
          </span>
        )}
        {filtered && <button type="button" className="events-clear" onClick={clearFilters}>Clear filters</button>}
      </div>

      <div className="events-content">
        {error && events.length === 0 ? (
          <ErrorState error={error} title="Couldn't load events" onRetry={refetch} busy={refetching} />
        ) : (
          <>
            {error && <ErrorState compact error={error} title="Latest refresh failed — showing previous events" onRetry={refetch} busy={refetching} />}
            <DataTable
              caption={`Events in ${nsLabel}${workload ? ` for ${wKind} ${wName}` : ''}`}
              columns={columns}
              rows={events}
              rowKey={eventKey}
              rowName={(e) => `${e.reason || 'event'} ${e.involvedObject || ''}`}
              getRowTone={(e) => (String(e.type).toLowerCase() === 'warning' ? 'warn' : undefined)}
              loading={loading}
              refetching={refetching}
              emptyState={filtered ? (
                <EmptyState
                  icon="events"
                  title="No events match these filters"
                  hint={workload ? `Nothing recent for ${wKind} ${wName} or ${SCOPE_NOTE[wKind] || 'what it owns'} — events are kept for about an hour.` : 'Try another search, or show all types.'}
                  action={<Button variant="secondary" size="sm" onClick={clearFilters}>Clear filters</Button>}
                />
              ) : (
                <EmptyState icon="events" title="No recent events" hint={single ? `No events in namespace ${single}. Try “all namespaces”.` : 'The cluster has not reported any events recently.'} />
              )}
              className="events-table-wrap"
            />
            {events.length < total && (
              <div className="events-more">
                <span>Showing {events.length.toLocaleString()} of {total.toLocaleString()}</span>
                <Button variant="secondary" size="sm" onClick={() => setPages((n) => n + 1)} disabled={refetching || loading}>
                  Load {Math.min(PAGE, total - events.length).toLocaleString()} more
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
