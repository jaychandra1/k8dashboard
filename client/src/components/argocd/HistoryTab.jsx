import Icon from '../Icons';
import Badge from '../ui/Badge';
import Tooltip from '../ui/Tooltip';
import { withKeys } from '../shared/keys';

/** Drawer tab: deployment history with "roll back" (sync to that revision). */
export default function HistoryTab({ history = [], onSyncRevision }) {
  if (!history.length) return <section className="drawer-section"><div className="argo-msg">No deployment history.</div></section>;
  return (
    <section className="drawer-section">
      <h3 className="drawer-section-title">Deployment history ({history.length})</h3>
      <ol className="argo-history">
        {withKeys(history, (h) => h.id ?? `${h.revision}|${h.deployedAt}`).map(({ key, item: h }, i) => (
          <li key={key} className="argo-hist-row">
            <div className="argo-hist-main">
              <span className="argo-hist-rev" title={h.revision}>{(h.revision || '').slice(0, 12) || '(unknown)'}</span>
              <span className="argo-hist-time">{h.deployedAt ? new Date(h.deployedAt).toLocaleString() : ''}</span>
            </div>
            {i !== 0 && h.revision && (
              <Tooltip content={`Sync to ${h.revision.slice(0, 12)}`}>
                <button type="button" className="argo-hist-rollback" onClick={() => onSyncRevision(h.revision)}>
                  <Icon name="refresh" size={12} /> Roll back
                </button>
              </Tooltip>
            )}
            {i === 0 && <Badge tone="ok" size="sm">current</Badge>}
          </li>
        ))}
      </ol>
    </section>
  );
}

export { HistoryTab };
