import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import Icon from '../Icons';
import { useToast } from '../Toast';
import { askLabel } from '../../aiConfig';
import useRequest from '../../hooks/useRequest';
import { getJson, postJson, del, p, errorMessage } from '../../lib/api';
import { KIND_TYPE } from '../../lib/kinds';
import ErrorState from '../ui/ErrorState';
import Skeleton from '../ui/Skeleton';
import { ConfirmModal } from '../ui/Modal';
import { errorTitle } from '../shared/errors';
import { navToResource } from '../shared/nav';
import Dashboard from './Dashboard';
import AppsTable from './AppsTable';
import AppDetail from './AppDetail';
import AppGraphPanel from './AppGraphPanel';
import ArgoSelect from './ArgoSelect';
import { AppSetsTable, ProjectsTable, RepositoriesTable, ClustersTable } from './SimpleTables';
import SyncModal from './SyncModal';
import DeleteModal from './DeleteModal';
import BulkModal from './BulkModal';
import { appKey, sameApp, needsAttention, resourceNeedsAttention, tablistKeys } from './status';

// Argo CD dashboard — auto-detected when the applications.argoproj.io CRD
// exists. Sub-views (route param): dashboard, applications, view (resource
// graph), appsets, projects, repositories, clusters. The selected application
// comes from the route (`selectedApp` / `onSelectApp`) when the App shell
// provides it, otherwise it is kept locally.

const TABS = [
  { key: 'dashboard', label: 'Dashboard', icon: 'overview' },
  { key: 'applications', label: 'Applications', icon: 'argocd' },
  { key: 'view', label: 'View', icon: 'topology' },
  { key: 'appsets', label: 'Application Sets', icon: 'box' },
  { key: 'projects', label: 'Projects', icon: 'accessControl' },
  { key: 'repositories', label: 'Repositories', icon: 'git' },
  { key: 'clusters', label: 'Clusters', icon: 'cluster' },
];
const TAB_KEYS = TABS.map((t) => t.key);
const APP_PATH = (app) => p('api', 'argocd', 'application', app.namespace, app.name);
const contextKey = (c) => (typeof c === 'string' ? c : c?.currentContext || c?.name || '');

export default function ArgoCD({ view, onViewChange, refreshSignal = 0, onNavigate, context, selectedApp, onSelectApp }) {
  const toast = useToast();
  const id = useId();

  // Sub-view: from the route when provided, local otherwise (no mirrored state).
  const [localView, setLocalView] = useState('dashboard');
  const tab = view && TAB_KEYS.includes(view) ? view : (view ? 'dashboard' : localView);
  const selectTab = useCallback((t) => { setLocalView(t); onViewChange?.(t); }, [onViewChange]);

  // Selected application: from the route when provided, local otherwise.
  const [localSel, setLocalSel] = useState(null);
  const selected = selectedApp !== undefined ? selectedApp : localSel;
  const setSelected = useCallback((a) => { setLocalSel(a); onSelectApp?.(a); }, [onSelectApp]);

  const ctx = contextKey(context);
  const deps = [refreshSignal, ctx];
  const appsReq = useRequest(({ signal }) => getJson(p('api', 'argocd', 'applications'), { signal }), { deps, pollMs: 30000, dedupeKey: `argocd:apps:${ctx}` });
  const projectsReq = useRequest(({ signal }) => getJson(p('api', 'argocd', 'projects'), { signal }), { deps, dedupeKey: `argocd:projects:${ctx}` });
  const appSetsReq = useRequest(({ signal }) => getJson(p('api', 'argocd', 'applicationsets'), { signal }), { deps, dedupeKey: `argocd:appsets:${ctx}` });
  const reposReq = useRequest(({ signal }) => getJson(p('api', 'argocd', 'repositories'), { signal }), { deps, dedupeKey: `argocd:repos:${ctx}` });
  const clustersReq = useRequest(({ signal }) => getJson(p('api', 'argocd', 'clusters'), { signal }), { deps, dedupeKey: `argocd:clusters:${ctx}` });
  const statusReq = useRequest(({ signal }) => getJson(p('api', 'argocd', 'status'), { signal }), { deps, dedupeKey: `argocd:status:${ctx}` });

  const apps = useMemo(() => appsReq.data?.applications || [], [appsReq.data]);
  const projects = projectsReq.data?.projects || [];
  const appSets = appSetsReq.data?.applicationSets || [];
  const appSetsAvailable = appSetsReq.data?.available !== false;
  const repositories = reposReq.data?.repositories || [];
  const clusters = clustersReq.data?.clusters || [];
  const argoUrl = statusReq.data?.url || '';
  const { refetch: refetchApps } = appsReq;
  const reloadApps = useCallback((delay = 1000) => { setTimeout(() => refetchApps(), delay); }, [refetchApps]);

  const [search, setSearch] = useState('');
  const [syncFilter, setSyncFilter] = useState(null);
  const [healthFilter, setHealthFilter] = useState(null);
  const [selRows, setSelRows] = useState(() => new Set());
  const [navNs, setNavNs] = useState('');
  const [graphCount, setGraphCount] = useState(null);

  const [syncDialog, setSyncDialog] = useState(null);   // { app, revision? }
  const [confirmDel, setConfirmDel] = useState(null);   // app
  const [hardRefresh, setHardRefresh] = useState(null); // app
  const [bulk, setBulk] = useState(null);               // { type, apps, preselectAll }
  const [busy, setBusy] = useState(false);

  const counts = useMemo(() => {
    const sync = {}; const health = {};
    for (const a of apps) { sync[a.syncStatus] = (sync[a.syncStatus] || 0) + 1; health[a.healthStatus] = (health[a.healthStatus] || 0) + 1; }
    const healthy = apps.filter((a) => a.syncStatus === 'Synced' && a.healthStatus === 'Healthy').length;
    return { sync, health, healthy };
  }, [apps]);
  const attention = useMemo(() => apps.filter(needsAttention), [apps]);
  const recent = useMemo(() => apps.filter((a) => a.lastOperation?.finishedAt)
    .sort((a, b) => new Date(b.lastOperation.finishedAt) - new Date(a.lastOperation.finishedAt)).slice(0, 12), [apps]);
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return apps.filter((a) =>
      (!q || a.name.toLowerCase().includes(q) || (a.project || '').toLowerCase().includes(q) || (a.destNamespace || '').toLowerCase().includes(q))
      && (!syncFilter || a.syncStatus === syncFilter)
      && (!healthFilter || a.healthStatus === healthFilter));
  }, [apps, search, syncFilter, healthFilter]);

  // View tab navigator: namespaces that hold Applications, apps in the picked one.
  const navNamespaces = useMemo(() => [...new Set(apps.map((a) => a.namespace))].sort((a, b) => a.localeCompare(b)), [apps]);
  const navApps = useMemo(() => apps.filter((a) => !navNs || a.namespace === navNs).sort((a, b) => a.name.localeCompare(b.name)), [apps, navNs]);
  useEffect(() => {
    if ((!navNs || !navNamespaces.includes(navNs)) && navNamespaces.length) {
      setNavNs(navNamespaces.includes('argocd') ? 'argocd' : navNamespaces[0]);
    }
  }, [navNamespaces, navNs]);

  // ---- actions ----
  const doSync = async (app, options = {}) => {
    setBusy(true);
    try {
      const data = await postJson(`${APP_PATH(app)}/sync`, options);
      toast.success(data?.message || 'Sync triggered', { title: app.name });
      reloadApps();
    } catch (e) { toast.error(errorMessage(e), { title: 'Sync' }); }
    finally { setBusy(false); setSyncDialog(null); }
  };
  const doRefresh = async (app, hard = false) => {
    setBusy(true);
    try {
      const data = await postJson(`${APP_PATH(app)}/refresh`, { hard });
      toast.success(data?.message || `${hard ? 'Hard refresh' : 'Refresh'} requested`, { title: app.name });
      reloadApps();
    } catch (e) { toast.error(errorMessage(e), { title: 'Refresh' }); }
    finally { setBusy(false); setHardRefresh(null); }
  };
  const doDelete = async (app, { cascade }) => {
    setBusy(true);
    try {
      const data = await del(APP_PATH(app), { params: { cascade } });
      toast.success(data?.message || `${app.name} deleted`, { title: 'Delete' });
      setConfirmDel(null);
      if (sameApp(selected, app)) setSelected(null);
      reloadApps(800);
    } catch (e) { toast.error(errorMessage(e), { title: 'Delete' }); }
    finally { setBusy(false); }
  };
  const runBulk = async ({ type, apps: targets, prune, hard }) => {
    if (!targets.length) { setBulk(null); return; }
    setBusy(true);
    let ok = 0; let failed = 0; let lastErr = '';
    for (const app of targets) {
      try {
        if (type === 'sync') await postJson(`${APP_PATH(app)}/sync`, { prune });
        else await postJson(`${APP_PATH(app)}/refresh`, { hard });
        ok += 1;
      } catch (e) { failed += 1; lastErr = errorMessage(e); }
    }
    const verb = type === 'sync' ? 'Synced' : 'Refreshed';
    if (!failed) toast.success(`${verb} ${ok} application${ok === 1 ? '' : 's'}`, { title: 'Argo CD' });
    else toast.error(`${verb} ${ok}, ${failed} failed — ${lastErr}`, { title: 'Argo CD' });
    setBusy(false); setBulk(null); setSelRows(new Set()); reloadApps();
  };

  // Ask AI → Summarize: fetch the app's condition and hand it to the assistant.
  const summarize = async (app) => {
    toast.info(`Summarizing ${app.name}…`, { title: askLabel() });
    let d;
    try { d = await getJson(APP_PATH(app)); } catch { d = { app }; }
    const a = d.app || app;
    const bad = (d.resources || []).filter(resourceNeedsAttention);
    const lines = [
      `Analyze the current condition of the ArgoCD Application "${a.name}" (namespace ${a.namespace}, project ${a.project}).`,
      `Sync status: ${a.syncStatus}. Health status: ${a.healthStatus}${a.healthMessage ? ` — ${a.healthMessage}` : ''}.`,
      a.repoURL ? `Source: ${a.repoURL}${a.path ? ` (path ${a.path})` : ''} @ ${a.targetRevision || 'HEAD'}.` : '',
      `Destination: cluster ${a.destName || a.destServer || '?'}, namespace ${a.destNamespace || '?'}.`,
      bad.length ? `Resources needing attention:\n${bad.slice(0, 25).map((r) => `- ${r.kind}/${r.name}: sync=${r.syncStatus} health=${r.healthStatus || 'n/a'}${r.healthMessage ? ` (${r.healthMessage})` : ''}`).join('\n')}` : 'All managed resources are Synced and Healthy.',
      (d.conditions || []).length ? `Conditions:\n${d.conditions.map((c) => `- ${c.type}: ${c.message}`).join('\n')}` : '',
      'Explain what is wrong (if anything), the likely root cause, and concrete steps to fix it.',
    ].filter(Boolean);
    window.dispatchEvent(new CustomEvent('assistant:ask', { detail: { prompt: lines.join('\n') } }));
  };

  const openApp = useCallback((app) => { if (tab !== 'applications' && tab !== 'view') selectTab('applications'); setSelected(app); }, [tab, selectTab, setSelected]);
  const appActions = (app) => [
    { label: 'Show details', icon: 'details', onSelect: () => openApp(app) },
    { label: `Summarize (${askLabel()})`, icon: 'sparkles', onSelect: () => summarize(app) },
    { divider: true },
    { label: 'Sync…', icon: 'argocd', onSelect: () => setSyncDialog({ app }) },
    { label: 'Refresh', icon: 'refresh', onSelect: () => doRefresh(app, false) },
    { label: 'Hard refresh…', icon: 'refresh', onSelect: () => setHardRefresh(app) },
    { divider: true },
    { label: 'Delete…', icon: 'delete', danger: true, onSelect: () => setConfirmDel(app) },
  ];

  const selectedApps = () => apps.filter((a) => selRows.has(appKey(a)));
  const toggleRow = (a, key) => setSelRows((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const toggleAll = (checked, rows) => setSelRows((s) => {
    const n = new Set(s);
    rows.forEach((a) => { if (checked) n.add(appKey(a)); else n.delete(appKey(a)); });
    return n;
  });
  const openResourceFromGraph = (node) => navToResource(onNavigate, { type: KIND_TYPE[node.kind], namespace: node.namespace, name: node.name });

  const tabCount = { applications: apps.length, appsets: appSets.length, projects: projects.length, repositories: repositories.length, clusters: clusters.length };
  const initialLoading = appsReq.loading && apps.length === 0;
  const appsError = appsReq.error && apps.length === 0 && ['dashboard', 'applications', 'view'].includes(tab);
  const selKey = selected ? appKey(selected) : null;

  return (
    <div className="resource-viewer argo-view">
      <h1 className="sr-only">Argo CD</h1>
      <div className="resource-tabs argo-tabs" role="tablist" aria-label="Argo CD views">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`${id}-tab-${t.key}`}
            data-key={t.key}
            aria-selected={tab === t.key}
            aria-controls={`${id}-panel-${t.key}`}
            tabIndex={tab === t.key ? 0 : -1}
            className={`resource-tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => selectTab(t.key)}
            onKeyDown={(e) => tablistKeys(e, TAB_KEYS, tab, selectTab)}
          >
            <Icon name={t.icon} size={15} /> {t.label}
            {typeof tabCount[t.key] === 'number' && <span className="argo-tab-count">{tabCount[t.key]}</span>}
          </button>
        ))}
        {argoUrl && (
          <a className="argo-open-ui" href={argoUrl} target="_blank" rel="noreferrer">
            <Icon name="externalLink" size={13} /> Open Argo CD UI<span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
      </div>

      <div className="argo-tabpanel" role="tabpanel" id={`${id}-panel-${tab}`} aria-labelledby={`${id}-tab-${tab}`}>
        {initialLoading ? <div className="resource-table-wrapper"><Skeleton rows={8} cols={6} label="Loading Argo CD" /></div>
          : appsError ? (
            <div className="resource-table-wrapper">
              <ErrorState error={appsReq.error} title={errorTitle(appsReq.error, 'Argo CD applications')} onRetry={appsReq.refetch} busy={appsReq.refetching} />
            </div>
          ) : (
            <>
              {appsReq.data?.error && ['dashboard', 'applications', 'view'].includes(tab) && (
                <ErrorState error={appsReq.data.error} title="Some applications could not be read" onRetry={appsReq.refetch} busy={appsReq.refetching} compact />
              )}

              {tab === 'dashboard' && (
                <Dashboard
                  apps={apps} counts={counts} attention={attention} recent={recent}
                  appSets={appSets} appSetsAvailable={appSetsAvailable} projects={projects}
                  busy={busy}
                  onOpenApp={openApp}
                  onShowApplications={() => selectTab('applications')}
                  onBulk={(type) => setBulk({ type, apps, preselectAll: false })}
                />
              )}

              {tab === 'applications' && (
                <AppsTable
                  apps={apps} filtered={filtered} counts={counts}
                  search={search} onSearch={setSearch}
                  syncFilter={syncFilter} onSyncFilter={setSyncFilter}
                  healthFilter={healthFilter} onHealthFilter={setHealthFilter}
                  selectedKeys={selRows} onToggleSelect={toggleRow} onToggleAll={toggleAll} onClearSelection={() => setSelRows(new Set())}
                  activeKey={selKey} onActivate={setSelected} rowActions={appActions}
                  loading={appsReq.loading} refetching={appsReq.refetching}
                  busy={busy}
                  onBulkSync={() => setBulk({ type: 'sync', apps: selectedApps(), preselectAll: true })}
                  onBulkRefresh={() => setBulk({ type: 'refresh', apps: selectedApps(), preselectAll: true })}
                />
              )}

              {tab === 'view' && (
                <div className="argo-view-tab">
                  <div className="argo-navbar">
                    <div className="argo-navbar-field">
                      <span className="argo-navbar-label" aria-hidden="true">Namespace</span>
                      <ArgoSelect
                        label="Namespace" width={190} icon="namespace" placeholder="Namespace…"
                        value={navNs}
                        options={navNamespaces.map((ns) => ({ value: ns, label: ns }))}
                        onChange={(v) => setNavNs(v)}
                      />
                    </div>
                    <div className="argo-navbar-field">
                      <span className="argo-navbar-label" aria-hidden="true">Application</span>
                      <ArgoSelect
                        label="Application" width={280} icon="argocd" placeholder="Select an application…"
                        value={selected && selected.namespace === navNs ? selected.name : ''}
                        options={navApps.map((a) => ({ value: a.name, label: a.name }))}
                        onChange={(v) => setSelected(navApps.find((a) => a.name === v) || null)}
                      />
                    </div>
                    {selected && graphCount != null && (
                      <span className="argo-navbar-count" role="status">{graphCount} managed resource{graphCount === 1 ? '' : 's'}</span>
                    )}
                  </div>
                  {!selected ? (
                    <div className="argo-view-placeholder">Pick a namespace and an application to see its resource graph.</div>
                  ) : (
                    <AppGraphPanel key={selKey} app={selected} refreshSignal={refreshSignal} onOpenResource={onNavigate ? openResourceFromGraph : undefined} onCount={setGraphCount} />
                  )}
                </div>
              )}

              {tab === 'appsets' && <AppSetsTable req={appSetsReq} appSets={appSets} available={appSetsAvailable} />}
              {tab === 'projects' && <ProjectsTable req={projectsReq} projects={projects} />}
              {tab === 'repositories' && <RepositoriesTable req={reposReq} repositories={repositories} />}
              {tab === 'clusters' && <ClustersTable req={clustersReq} clusters={clusters} />}
            </>
          )}
      </div>

      {selected && tab !== 'view' && (
        <AppDetail
          key={selKey}
          app={selected}
          refreshSignal={refreshSignal}
          busy={busy}
          onClose={() => setSelected(null)}
          onSync={(app, revision) => setSyncDialog({ app, revision })}
          onRefresh={(app) => doRefresh(app, false)}
          onDelete={(app) => setConfirmDel(app)}
          onSummarize={summarize}
        />
      )}

      <SyncModal request={syncDialog} busy={busy} onConfirm={doSync} onCancel={() => setSyncDialog(null)} />
      <DeleteModal app={confirmDel} busy={busy} onConfirm={doDelete} onCancel={() => setConfirmDel(null)} />
      <ConfirmModal
        open={!!hardRefresh}
        title="Hard refresh"
        icon="refresh"
        busy={busy}
        confirmLabel="Hard refresh"
        message={<>Hard refresh <b>{hardRefresh?.name}</b>? This also clears Argo CD's cached manifests for the application.</>}
        onConfirm={() => doRefresh(hardRefresh, true)}
        onCancel={() => setHardRefresh(null)}
      />
      <BulkModal request={bulk} busy={busy} onConfirm={runBulk} onCancel={() => setBulk(null)} />
    </div>
  );
}
