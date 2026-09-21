import Icon from './Icons';
import Loader from './Loader';
import useRequest from '../hooks/useRequest';
import { getJson, p, withQuery } from '../lib/api';
import { formatAge } from '../lib/format';
import Button from './ui/Button';
import Tooltip from './ui/Tooltip';
import DataTable from './ui/DataTable';
import EmptyState from './ui/EmptyState';
import ErrorState from './ui/ErrorState';
import HighlightedCode from './ui/HighlightedCode';
import { errorTitle } from './shared/errors';
import { navToView } from './shared/nav';

// Main-area detail for the Custom Resources tree selection: a kind (list of
// instances) or a single instance (YAML).
//
// selection: { group, version, plural, kind?, scope?, name?, namespace?, level? } | null

const normalise = (sel) => (sel ? { ...sel, level: sel.level || (sel.name ? 'instance' : 'kind') } : null);
const hasNs = (ns) => ns && ns !== '-';

function CloseButton({ onClose }) {
  if (!onClose) return null;
  return (
    <Tooltip content="Close">
      <Button variant="ghost" size="sm" iconOnly icon="close" iconSize={17} ariaLabel="Close custom resource" className="cr-detail-close" onClick={onClose} />
    </Tooltip>
  );
}

function InstanceView({ sel, refreshSignal, onClose }) {
  const { data, error, loading, refetch, refetching } = useRequest(
    ({ signal }) => getJson(withQuery(p('api', 'customresource', sel.group, sel.version, sel.plural, sel.name), { namespace: hasNs(sel.namespace) ? sel.namespace : undefined }), { signal }),
    { deps: [sel.group, sel.version, sel.plural, sel.name, sel.namespace, refreshSignal], dedupeKey: `cr:${sel.group}/${sel.version}/${sel.plural}/${sel.namespace || ''}/${sel.name}` },
  );
  const yaml = data?.yaml || '';
  return (
    <div className="cr-detail">
      <div className="cr-detail-head">
        <div>
          <h1><Icon name="customResources" size={17} /> {sel.name}</h1>
          <div className="cr-detail-meta">
            <span>{sel.kind || sel.plural}</span>
            <span className="drawer-dim">{sel.group}/{sel.version}</span>
            {hasNs(sel.namespace) && <span className="drawer-dim">ns: {sel.namespace}</span>}
          </div>
        </div>
        <CloseButton onClose={onClose} />
      </div>
      <div className="cr-detail-body">
        {loading && !data ? <Loader label="Loading resource…" inline /> : error && !data ? (
          <div className="cr-detail-error">
            <ErrorState
              error={error}
              title={errorTitle(error, `${sel.kind || sel.plural} ${sel.name}`, { notFound: `${sel.kind || 'Resource'} ${sel.name} was not found` })}
              onRetry={refetch}
              busy={refetching}
            />
          </div>
        ) : (
          <HighlightedCode code={yaml} lang="yaml" className="yaml-code" />
        )}
      </div>
    </div>
  );
}

function KindView({ sel, refreshSignal, onClose, onSelectInstance }) {
  const { data, error, loading, refetch, refetching } = useRequest(
    ({ signal }) => getJson(p('api', 'customresources', sel.group, sel.version, sel.plural), { signal }),
    { deps: [sel.group, sel.version, sel.plural, refreshSignal], dedupeKey: `cr-list:${sel.group}/${sel.version}/${sel.plural}` },
  );
  const items = data?.items || [];
  return (
    <div className="cr-detail">
      <div className="cr-detail-head">
        <div>
          <h1><Icon name="customResources" size={17} /> {sel.kind || sel.plural}</h1>
          <div className="cr-detail-meta">
            <span className="drawer-dim">{sel.group}/{sel.version}</span>
            {sel.scope && <span className="drawer-chip">{sel.scope}</span>}
            <span className="resource-count" role="status">{items.length} instances</span>
          </div>
        </div>
        <CloseButton onClose={onClose} />
      </div>
      <div className="cr-detail-table">
        {error && !data ? (
          <div className="cr-detail-error">
            <ErrorState error={error} title={errorTitle(error, `${sel.kind || sel.plural} instances`)} onRetry={refetch} busy={refetching} />
          </div>
        ) : (
          <DataTable
            caption={`${sel.kind || sel.plural} instances`}
            columns={[
              { key: 'name', header: 'Name', sortable: true, ellipsis: true, width: 320, render: (it) => <span className="xlink resource-name-cell">{it.name}</span> },
              { key: 'namespace', header: 'Namespace', sortable: true, render: (it) => (hasNs(it.namespace) ? it.namespace : '—') },
              { key: 'age', header: 'Age', sortable: true, accessor: (it) => Date.parse(it.createdAt) || 0, render: (it) => formatAge(it.createdAt), align: 'right', mono: true },
            ]}
            rows={items}
            rowKey={(it) => `${it.namespace}/${it.name}`}
            rowName={(it) => it.name}
            onRowActivate={onSelectInstance}
            loading={loading}
            refetching={refetching}
            emptyState={<EmptyState icon="customResources" title="No instances found" />}
            initialSort={{ key: 'name', dir: 'asc' }}
            storageKey={`cr:${sel.plural}`}
          />
        )}
      </div>
    </div>
  );
}

export default function CustomResourceDetail({ selection, refreshSignal = 0, onNavigate, onSelect }) {
  const sel = normalise(selection);
  const select = (next) => {
    if (onSelect) onSelect(next);
    else navToView(onNavigate, 'customResources', next ? [next.group, next.version, next.plural, next.name].filter(Boolean) : []);
  };
  const canClose = !!onSelect || typeof onNavigate === 'function';

  if (!sel) {
    return (
      <div className="resource-viewer">
        <div className="cr-empty">
          <h1 className="sr-only">Custom Resources</h1>
          <Icon name="customResources" size={40} />
          <p>Select a custom resource from the tree in the sidebar.</p>
          <span>Expand <b>Custom Resources</b> → group → kind → instance.</span>
        </div>
      </div>
    );
  }
  const key = `${sel.level}:${sel.group}/${sel.version}/${sel.plural}/${sel.namespace || ''}/${sel.name || ''}`;
  return (
    <div className="resource-viewer">
      {sel.level === 'instance'
        ? <InstanceView key={key} sel={sel} refreshSignal={refreshSignal} onClose={canClose ? () => select(null) : undefined} />
        : <KindView key={key} sel={sel} refreshSignal={refreshSignal} onClose={canClose ? () => select(null) : undefined} onSelectInstance={(it) => select({ ...sel, level: 'instance', name: it.name, namespace: it.namespace })} />}
    </div>
  );
}
