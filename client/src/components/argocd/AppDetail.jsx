import { useId, useRef, useState } from 'react';
import Icon from '../Icons';
import Loader from '../Loader';
import Button from '../ui/Button';
import Tooltip from '../ui/Tooltip';
import ErrorState from '../ui/ErrorState';
import useClickOutside from '../../hooks/useClickOutside';
import { askLabel } from '../../aiConfig';
import { errorTitle } from '../shared/errors';
import useAppDetail from './useAppDetail';
import SummaryTab from './SummaryTab';
import TreeTab from './TreeTab';
import HistoryTab from './HistoryTab';
import { resourceNeedsAttention, tablistKeys } from './status';

const TABS = [['summary', 'Summary'], ['tree', 'Resources'], ['history', 'History']];

/**
 * Right-hand application drawer. Mount with `key={namespace/name}` so each
 * application gets its own request state (see useAppDetail).
 */
export default function AppDetail({ app, refreshSignal, busy, onClose, onSync, onRefresh, onDelete, onSummarize }) {
  const id = useId();
  const ref = useRef(null);
  const [tab, setTab] = useState('summary');
  const { data: detail, error, loading, refetch, refetching } = useAppDetail(app, refreshSignal);
  useClickOutside(ref, onClose, true);

  return (
    <div
      className="resource-drawer argo-drawer"
      ref={ref}
      role="region"
      aria-labelledby={`${id}-title`}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
    >
      <div className="drawer-header">
        <div className="drawer-title">
          <div className="drawer-title-icon blue"><Icon name="argocd" size={18} /></div>
          <div className="drawer-title-text">
            <span className="drawer-kind">Application · {app.project}</span>
            <h2 id={`${id}-title`} className="drawer-name" title={app.name}>{app.name}</h2>
          </div>
        </div>
        <div className="drawer-actions">
          <Tooltip content={`Summarize (${askLabel()})`}>
            <Button variant="ghost" size="sm" iconOnly icon="sparkles" ariaLabel={`Summarize with ${askLabel()}`} onClick={() => onSummarize(app)} />
          </Tooltip>
          <Tooltip content="Refresh">
            <Button variant="ghost" size="sm" iconOnly icon="refresh" ariaLabel="Refresh application" disabled={busy} onClick={() => onRefresh(app)} />
          </Tooltip>
          <Tooltip content="Sync">
            <Button variant="ghost" size="sm" iconOnly icon="argocd" ariaLabel="Sync application" className="argo-sync" disabled={busy} onClick={() => onSync(app)} />
          </Tooltip>
          <Tooltip content="Delete">
            <Button variant="ghost" size="sm" iconOnly icon="delete" ariaLabel="Delete application" className="danger" disabled={busy} onClick={() => onDelete(app)} />
          </Tooltip>
          <Tooltip content="Close">
            <Button variant="ghost" size="sm" iconOnly icon="close" iconSize={17} ariaLabel="Close application details" onClick={onClose} />
          </Tooltip>
        </div>
      </div>

      <div className="argo-drawer-tabs" role="tablist" aria-label="Application details">
        {TABS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            id={`${id}-tab-${k}`}
            data-key={k}
            aria-selected={tab === k}
            aria-controls={`${id}-panel-${k}`}
            tabIndex={tab === k ? 0 : -1}
            className={`argo-dtab ${tab === k ? 'active' : ''}`}
            onClick={() => setTab(k)}
            onKeyDown={(e) => tablistKeys(e, TABS.map(([key]) => key), tab, setTab)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="drawer-body" role="tabpanel" id={`${id}-panel-${tab}`} aria-labelledby={`${id}-tab-${tab}`}>
        {loading && !detail ? <Loader label="Loading…" inline />
          : error && !detail ? <ErrorState error={error} title={errorTitle(error, `application ${app.name}`)} onRetry={refetch} busy={refetching} compact />
          : detail ? (
            <>
              {detail.error && <ErrorState error={detail.error} title="Some details are missing" compact />}
              {tab === 'summary' && <SummaryTab detail={detail} attentionResources={(detail.resources || []).filter(resourceNeedsAttention)} />}
              {tab === 'tree' && <TreeTab app={detail.app} resources={detail.resources || []} />}
              {tab === 'history' && <HistoryTab history={detail.history || []} onSyncRevision={(rev) => onSync(app, rev)} />}
            </>
          ) : null}
      </div>
    </div>
  );
}

export { AppDetail };
