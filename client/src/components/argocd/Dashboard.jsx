import Icon from '../Icons';
import Badge, { StatusDot } from '../ui/Badge';
import { formatAge } from '../../lib/format';
import { SYNC_ORDER, HEALTH_ORDER, syncTone, healthTone, opTone, appKey } from './status';

/** Dashboard tab: status bar, KPI cards, needs-attention and recent activity. */
export default function Dashboard({
  apps = [], counts, attention = [], recent = [],
  appSets = [], appSetsAvailable = true, projects = [],
  busy, onOpenApp, onShowApplications, onBulk,
}) {
  return (
    <div className="argo-dashboard">
      <ul className="argo-statusbar" aria-label="Application status totals">
        {SYNC_ORDER.filter((s) => counts.sync[s]).map((s) => (
          <li key={s} className={`argo-stat ${syncTone(s)}`}><b>{counts.sync[s]}</b> {s}</li>
        ))}
        <li className="argo-statusbar-sep" aria-hidden="true" />
        {HEALTH_ORDER.filter((h) => counts.health[h]).map((h) => (
          <li key={h} className={`argo-stat ${healthTone(h)}`}><b>{counts.health[h]}</b> {h}</li>
        ))}
      </ul>

      <div className="argo-cards">
        <section className="argo-card" aria-label="Applications">
          <div className="argo-card-head"><Icon name="argocd" size={16} /> Applications</div>
          <div className="argo-card-big">{counts.healthy}<span>/{apps.length}</span></div>
          <div className="argo-card-sub">{counts.healthy === apps.length ? 'all healthy' : `${apps.length - counts.healthy} need attention`}</div>
          {apps.length > 0 && (
            <div className="argo-card-actions">
              <button type="button" className="bulk-btn" disabled={busy} onClick={() => onBulk('sync')}>
                <Icon name="argocd" size={14} /> Sync
              </button>
              <button type="button" className="bulk-btn" disabled={busy} onClick={() => onBulk('refresh')}>
                <Icon name="refresh" size={14} /> Refresh
              </button>
            </div>
          )}
        </section>
        <section className="argo-card" aria-label="Application Sets">
          <div className="argo-card-head"><Icon name="box" size={16} /> Application Sets</div>
          <div className="argo-card-big">{appSets.length}</div>
          <div className="argo-card-sub">{appSetsAvailable ? 'total' : 'controller not installed'}</div>
        </section>
        <section className="argo-card" aria-label="Projects">
          <div className="argo-card-head"><Icon name="accessControl" size={16} /> Projects</div>
          <div className="argo-card-big">{projects.length}</div>
          <div className="argo-card-sub">total</div>
        </section>
      </div>

      <section className="argo-panel">
        <h2 className="argo-panel-title">Needs attention {attention.length > 0 && <span className="argo-panel-count">{attention.length}</span>}</h2>
        {attention.length === 0 ? (
          <div className="argo-panel-empty"><Icon name="check" size={15} /> All applications are synced and healthy.</div>
        ) : (
          <ul className="argo-mini-table">
            {attention.slice(0, 12).map((a) => (
              <li key={appKey(a)}>
                <button type="button" className="argo-mini-row" onClick={() => onOpenApp(a)}>
                  <span className="argo-mini-name">{a.name}</span>
                  <span className="argo-mini-ns">{a.destNamespace || a.namespace}</span>
                  <Badge tone={syncTone(a.syncStatus)}>{a.syncStatus}</Badge>
                  <Badge tone={healthTone(a.healthStatus)}>{a.healthStatus}</Badge>
                </button>
              </li>
            ))}
            {attention.length > 12 && (
              <li><button type="button" className="argo-mini-more" onClick={onShowApplications}>+{attention.length - 12} more…</button></li>
            )}
          </ul>
        )}
      </section>

      <section className="argo-panel">
        <h2 className="argo-panel-title">Recent activity</h2>
        {recent.length === 0 ? <div className="argo-panel-empty">No recent sync operations.</div> : (
          <ul className="argo-mini-table">
            {recent.map((a) => (
              <li key={appKey(a)}>
                <button type="button" className="argo-mini-row" onClick={() => onOpenApp(a)}>
                  <StatusDot tone={opTone(a.lastOperation.phase)} label={a.lastOperation.phase} className="argo-dot" />
                  <span className="argo-mini-name">{a.name}</span>
                  <span className="argo-mini-msg">{a.lastOperation.phase} · {a.lastOperation.message || 'sync operation'}</span>
                  <span className="argo-mini-age">{formatAge(a.lastOperation.finishedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export { Dashboard };
