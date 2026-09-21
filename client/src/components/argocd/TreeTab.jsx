import Icon from '../Icons';
import Badge, { StatusDot } from '../ui/Badge';
import { withKeys } from '../shared/keys';
import { healthTone, syncTone, resourceKey } from './status';

/** Drawer tab: flat list of the resources the Application manages. */
export default function TreeTab({ app, resources = [] }) {
  return (
    <section className="drawer-section" aria-label="Managed resources">
      <div className="argo-tree">
        <div className="argo-tree-root">
          <Icon name="argocd" size={14} />
          <span className="argo-tree-app">{app.name}</span>
          <Badge tone={syncTone(app.syncStatus)}>{app.syncStatus}</Badge>
          <Badge tone={healthTone(app.healthStatus)}>{app.healthStatus}</Badge>
        </div>
        <ul className="argo-tree-children">
          {resources.length === 0 && <li className="argo-msg">No resources reported.</li>}
          {withKeys(resources, resourceKey).map(({ key, item: r }) => (
            <li key={key} className="argo-tree-node">
              <span className="argo-tree-branch" aria-hidden="true" />
              <StatusDot tone={syncTone(r.syncStatus)} label={`Sync: ${r.syncStatus}`} className="argo-dot" />
              <span className="argo-res-kind">{r.kind}</span>
              <span className="argo-res-name" title={`${r.namespace ? `${r.namespace}/` : ''}${r.name}`}>{r.name}</span>
              {r.healthStatus && <Badge tone={healthTone(r.healthStatus)} size="sm">{r.healthStatus}</Badge>}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export { TreeTab };
