import { useMemo } from 'react';
import LogsViewer from './LogsViewer';
import Skeleton from './ui/Skeleton';
import ErrorState from './ui/ErrorState';
import Icon from './Icons';
import useRequest from '../hooks/useRequest';
import { getJson, p } from '../lib/api';

// Pods come and go during rollouts; re-read the list now and then.
const PODS_POLL_MS = 30000;

/**
 * Logs of a Deployment: finds its pods (the Deployment's selector, like
 * `kubectl logs deploy/<name>`) and hands them to <LogsViewer> in workload
 * mode — "All pods" merged, or one replica.
 *   <DeploymentLogs namespace name onClose />
 */
export default function DeploymentLogs({ namespace, name, onClose }) {
  const { data, error, loading, refetch, refetching } = useRequest(
    ({ signal }) => getJson(p('api', 'deployments', namespace, name, 'pods'), { signal }),
    { deps: [namespace, name], enabled: !!namespace && !!name, pollMs: PODS_POLL_MS, dedupeKey: `deployment-pods:${namespace}/${name}` },
  );
  const pods = useMemo(
    () => (data?.pods || []).map((x) => ({ name: x.name, containerNames: x.containerNames || [], status: x.status })),
    [data],
  );

  if (pods.length) {
    return <LogsViewer namespace={namespace} workload={{ kind: 'Deployment', name }} pods={pods} totalPods={data?.total} onClose={onClose} />;
  }

  let body;
  if (loading && !data) body = <Skeleton block height={120} label={`Finding the pods of ${name}`} />;
  else if (error && !data) body = <ErrorState compact error={error} title={`Couldn't find the pods of ${name}`} onRetry={refetch} busy={refetching} />;
  else body = <span className="logs-empty">No pods are running for <b>{name}</b> — scale it up or check its events.</span>;

  return (
    <div className="logs-viewer">
      <div className="logs-toolbar" role="toolbar" aria-label="Log controls">
        <button type="button" className="logs-icon-btn" onClick={refetch} aria-label="Reload pods" aria-busy={refetching || undefined}><Icon name="refresh" size={15} /></button>
        <div className="logs-spacer" />
        {onClose && (
          <button type="button" className="logs-icon-btn" onClick={onClose} aria-label={`Close logs for ${name}`}><Icon name="close" size={15} /></button>
        )}
      </div>
      <div className="logs-body" role="log" aria-label={`Logs for ${name}`} aria-busy={loading || refetching || undefined}>
        <div className="logs-center">{body}</div>
      </div>
    </div>
  );
}
