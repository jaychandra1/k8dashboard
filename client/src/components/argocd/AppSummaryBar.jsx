import Icon from '../Icons';
import { statusClass } from '../../lib/status';
import { formatAgeLong } from '../../lib/format';
import { healthTone, syncTone, opTone } from './status';

/** App Health / Sync Status / Last Sync summary strip above the graph (Argo CD style). */
export default function AppSummaryBar({ detail }) {
  const a = detail.app || {};
  const op = detail.operationState;
  const auto = !!(detail.syncPolicy && detail.syncPolicy.automated);
  return (
    <dl className="argo-appsum">
      <div className="argo-appsum-card">
        <dt className="argo-appsum-label">App Health</dt>
        <dd className={`argo-appsum-main ${statusClass(healthTone(a.healthStatus))}`}>
          <Icon name="heart" size={18} style={{ fill: 'currentColor' }} /> {a.healthStatus || 'Unknown'}
        </dd>
      </div>
      <div className="argo-appsum-card">
        <dt className="argo-appsum-label">Sync Status</dt>
        <dd className={`argo-appsum-main ${statusClass(syncTone(a.syncStatus))}`}>
          <Icon name={a.syncStatus === 'Synced' ? 'check' : 'refresh'} size={16} strokeWidth={2.4} /> {a.syncStatus || 'Unknown'}
          {a.revision && <span className="argo-appsum-rev">to {String(a.revision).slice(0, 7)}</span>}
        </dd>
        <dd className="argo-appsum-sub">{auto ? 'Auto sync is enabled.' : 'Auto sync is not enabled.'}</dd>
      </div>
      {op && (
        <div className="argo-appsum-card">
          <dt className="argo-appsum-label">Last Sync</dt>
          <dd className={`argo-appsum-main ${op.phase === 'Succeeded' || op.phase === 'Failed' || op.phase === 'Error' ? statusClass(opTone(op.phase)) : ''}`}>
            <Icon name={op.phase === 'Succeeded' ? 'check' : 'warning'} size={16} strokeWidth={2.4} /> {op.phase === 'Succeeded' ? 'Sync OK' : op.phase}
            {op.revision && <span className="argo-appsum-rev">to {op.revision}</span>}
          </dd>
          <dd className="argo-appsum-sub">{op.phase}{op.finishedAt ? ` ${formatAgeLong(op.finishedAt)}` : ''}</dd>
        </div>
      )}
    </dl>
  );
}

export { AppSummaryBar };
