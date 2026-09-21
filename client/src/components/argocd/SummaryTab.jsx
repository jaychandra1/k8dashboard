import Badge, { StatusDot } from '../ui/Badge';
import { formatAge } from '../../lib/format';
import { withKeys } from '../shared/keys';
import { healthTone, syncTone, resourceKey } from './status';

const externalHref = (url) => (url.startsWith('http') ? url : `https://${url}`);

/** Drawer tab: status, needs-attention resources, properties, source, destination, policy, last op, conditions, events. */
export default function SummaryTab({ detail, attentionResources = [] }) {
  const a = detail.app;
  return (
    <>
      <section className="drawer-section" aria-label="Status">
        <div className="argo-status-row">
          <Badge tone={syncTone(a.syncStatus)}>{a.syncStatus}</Badge>
          <Badge tone={healthTone(a.healthStatus)}>{a.healthStatus}</Badge>
          {a.autoSync && <Badge tone="muted" dot={false}>auto-sync</Badge>}
        </div>
        {a.healthMessage && <div className="argo-msg">{a.healthMessage}</div>}
      </section>

      {attentionResources.length > 0 && (
        <section className="drawer-section">
          <h3 className="drawer-section-title">Needs attention ({attentionResources.length})</h3>
          <ul className="argo-res-list">
            {withKeys(attentionResources, resourceKey).map(({ key, item: r }) => (
              <li key={key} className="argo-res">
                <StatusDot tone={syncTone(r.syncStatus)} label={`Sync: ${r.syncStatus}`} className="argo-dot" />
                <span className="argo-res-kind">{r.kind}</span>
                <span className="argo-res-name" title={`${r.namespace ? `${r.namespace}/` : ''}${r.name}`}>{r.name}</span>
                {r.healthStatus && <Badge tone={healthTone(r.healthStatus)} size="sm">{r.healthStatus}</Badge>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="drawer-section">
        <h3 className="drawer-section-title">Properties</h3>
        <div className="argo-kv">
          <div><span>Created</span><code>{a.createdAt ? new Date(a.createdAt).toLocaleString() : '-'}</code></div>
          <div><span>Reconciled</span><code>{a.reconciledAt ? new Date(a.reconciledAt).toLocaleString() : '-'}</code></div>
          {a.controlledBy && <div><span>App&nbsp;Set</span><code>{a.controlledBy}</code></div>}
          {a.finalizers?.length > 0 && <div><span>Finalizers</span><code>{a.finalizers.join(', ')}</code></div>}
          {a.images?.length > 0 && <div><span>Images</span><code>{a.images.join('\n')}</code></div>}
        </div>
      </section>

      <section className="drawer-section">
        <h3 className="drawer-section-title">Source</h3>
        {withKeys(detail.sources || [], (s) => `${s.repoURL || ''}|${s.path || s.chart || ''}|${s.targetRevision || ''}`).map(({ key, item: s }) => (
          <div key={key} className="argo-kv">
            <div><span>Repo</span>{s.repoURL ? <a className="xlink argo-kv-link" href={externalHref(s.repoURL)} target="_blank" rel="noreferrer">{s.repoURL}</a> : <code>-</code>}</div>
            {(s.path || s.chart) && <div><span>{s.chart ? 'Chart' : 'Path'}</span><code>{s.path || s.chart}</code></div>}
            <div><span>Target</span><code>{s.targetRevision || 'HEAD'}</code></div>
          </div>
        ))}
      </section>

      <section className="drawer-section">
        <h3 className="drawer-section-title">Destination</h3>
        <div className="argo-kv">
          <div><span>Cluster</span><code>{detail.destination?.name || detail.destination?.server || '-'}</code></div>
          <div><span>Namespace</span><code>{detail.destination?.namespace || '-'}</code></div>
        </div>
      </section>

      <section className="drawer-section">
        <h3 className="drawer-section-title">Sync Policy</h3>
        {detail.syncPolicy?.automated ? (
          <div className="argo-status-row">
            <Badge tone="info" dot={false}>automated</Badge>
            {detail.syncPolicy.automated.prune && <Badge tone="muted" dot={false}>prune</Badge>}
            {detail.syncPolicy.automated.selfHeal && <Badge tone="muted" dot={false}>self-heal</Badge>}
          </div>
        ) : <div className="argo-msg">Manual — syncs are triggered by hand.</div>}
        {detail.syncPolicy?.syncOptions?.length > 0 && (
          <div className="argo-status-row argo-status-row-gap">
            {withKeys(detail.syncPolicy.syncOptions, (o) => o).map(({ key, item: o }) => <Badge key={key} tone="muted" dot={false}>{o}</Badge>)}
          </div>
        )}
      </section>

      {detail.operationState && (
        <section className="drawer-section">
          <h3 className="drawer-section-title">Last Operation</h3>
          <div className="argo-kv">
            <div><span>Phase</span><code>{detail.operationState.phase || '-'}</code></div>
            {detail.operationState.revision && <div><span>Revision</span><code>{detail.operationState.revision}</code></div>}
            {detail.operationState.finishedAt && <div><span>Finished</span><code>{new Date(detail.operationState.finishedAt).toLocaleString()}</code></div>}
          </div>
          {detail.operationState.message && <div className="argo-msg">{detail.operationState.message}</div>}
        </section>
      )}

      {detail.conditions?.length > 0 && (
        <section className="drawer-section">
          <h3 className="drawer-section-title">Conditions</h3>
          {withKeys(detail.conditions, (c) => `${c.type}:${c.message}`).map(({ key, item: c }) => <div key={key} className="argo-msg"><b>{c.type}:</b> {c.message}</div>)}
        </section>
      )}

      {detail.events?.length > 0 && (
        <section className="drawer-section">
          <h3 className="drawer-section-title">Events ({detail.events.length})</h3>
          <ul className="argo-events">
            {withKeys(detail.events, (e) => `${e.reason}|${e.lastTimestamp}|${e.message}`).map(({ key, item: e }) => (
              <li key={key} className={`argo-event ${e.type === 'Warning' ? 'warn' : ''}`}>
                <span className="argo-event-reason">{e.reason}</span>
                <span className="argo-event-msg">{e.message}</span>
                <span className="argo-event-age">{formatAge(e.lastTimestamp)}{e.count > 1 ? ` ×${e.count}` : ''}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

export { SummaryTab };
