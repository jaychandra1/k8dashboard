import { useEffect } from 'react';
import Loader from '../Loader';
import ErrorState from '../ui/ErrorState';
import { errorTitle } from '../shared/errors';
import useAppDetail from './useAppDetail';
import AppSummaryBar from './AppSummaryBar';
import AppResourceGraph from './AppResourceGraph';

/**
 * Body of the "View" tab for one application: summary strip + resource graph.
 * Mount with `key={namespace/name}` so each app has its own request state.
 */
export default function AppGraphPanel({ app, refreshSignal, onOpenResource, onCount }) {
  const { data: detail, error, loading, refetch, refetching } = useAppDetail(app, refreshSignal);
  const count = (detail?.resources || []).length;
  useEffect(() => { if (detail) onCount?.(count); }, [detail, count, onCount]);
  if (loading && !detail) return <div className="argo-view-placeholder"><Loader label={`Loading ${app.name}…`} /></div>;
  if (error && !detail) {
    return <div className="argo-view-placeholder"><ErrorState error={error} title={errorTitle(error, `application ${app.name}`)} onRetry={refetch} busy={refetching} /></div>;
  }
  if (!detail) return null;
  return (
    <>
      {detail.error && <ErrorState error={detail.error} title="Some details are missing" compact />}
      <AppSummaryBar detail={detail} />
      <AppResourceGraph app={detail.app} resources={detail.resources || []} onOpenResource={onOpenResource} />
    </>
  );
}

export { AppGraphPanel };
