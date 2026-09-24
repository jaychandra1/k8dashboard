import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import Navigation, { ARGO_ITEMS, ARGO_SETTINGS_ITEMS, SECURITY_ITEMS } from './components/Navigation';
import TopBar from './components/TopBar';
import ClusterSwitcher from './components/ClusterSwitcher';
import Icon from './components/Icons';
import Tooltip from './components/ui/Tooltip';
import CommandPalette from './components/CommandPalette';
import KubeConfigModal from './components/KubeConfigModal';
import AuthErrorModal from './components/AuthErrorModal';
import AzureIntegration from './components/AzureIntegration';
import AwsIntegration from './components/AwsIntegration';
import Assistant from './components/Assistant';
import AgentPanel from './components/AgentPanel';
import { useToast } from './components/Toast';
import TokenPrompt from './components/ui/TokenPrompt';
import ErrorBoundary from './components/ui/ErrorBoundary';
import useHashRoute from './hooks/useHashRoute';
import useDocumentTitle from './hooks/useDocumentTitle';
import useRequest from './hooks/useRequest';
import { bootstrapTokenFromHash, getToken, onUnauthorized, getJson } from './lib/api';
import { RESOURCE_TYPES, byKey, pluralKey } from './lib/kinds';
import { refreshMs } from './components/RefreshControl';
import useAuthGate from './components/shell/useAuthGate';
import useContexts from './components/shell/useContexts';
import usePins from './components/shell/usePins';
import useNamespaces from './components/shell/useNamespaces';
import useResourceFanOut from './components/shell/useResourceFanOut';
import useNavDrawer from './components/shell/useNavDrawer';
import ShortcutsSheet from './components/shell/ShortcutsSheet';
import ViewOutlet from './components/shell/ViewOutlet';
import LoadingScreen from './components/shell/LoadingScreen';
import ContextPickerModal, { OPEN_CONTEXTS_EVENT } from './components/ContextPickerModal';
import {
  ALL, DEFAULT_VIEW, nsFromQuery, nsToQuery, isKnownView, isResourceView,
  selectionFromRoute, selectionToParams, crSelectionFromRoute, crSelectionToParams, namespaceTargetView,
} from './components/shell/routes';

// Pull `#token=…` into sessionStorage before the first request (main.jsx does
// this too; calling it again is a no-op once the hash is scrubbed).
bootstrapTokenFromHash();

const isEditable = (el) => {
  if (!el || el === document.body) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
    || el.getAttribute?.('role') === 'textbox' || !!el.closest?.('.xterm');
};

const byPlural = Object.fromEntries(RESOURCE_TYPES.map((t) => [t.plural, t]));

// A context switch shows the branded LoadingScreen over <main> until the new
// cluster's summary is on screen — but never longer than this, so a slow
// cluster hands over to the view's own skeletons instead of trapping the user.
const SWITCH_OVERLAY_CAP_MS = 8000;

function App() {
  const toast = useToast();

  // ---- token gate --------------------------------------------------------
  const [tokenOk, setTokenOk] = useState(() => !!getToken());
  const [session, setSession] = useState(0); // bumps after a (re)connect so the gate re-runs
  useEffect(() => onUnauthorized(() => setTokenOk(false)), []);
  const onTokenSuccess = useCallback(() => { setTokenOk(true); setSession((s) => s + 1); }, []);

  // ---- routing -----------------------------------------------------------
  const { route, navigate, back, forward, canBack, canForward, setQuery } = useHashRoute();
  const view = route.view;
  const selectedNamespaces = useMemo(() => nsFromQuery(route.query), [route.query]);
  const selectedKey = useMemo(() => selectionFromRoute(route), [route]);
  const crSelection = useMemo(() => crSelectionFromRoute(route), [route]);
  const subView = view === 'argocd' ? (route.params[0] || 'dashboard') : view === 'security' ? (route.params[0] || 'overview') : null;
  const prefSection = view === 'preferences' ? (route.params[0] || 'general') : null;
  const focusNode = view === 'nodes' ? (route.params[0] || null) : null;
  const nsQuery = route.query.ns;

  // Unknown view key in the hash → the landing view (Cluster overview).
  useEffect(() => {
    if (!isKnownView(view)) navigate(DEFAULT_VIEW, [], {}, { replace: true });
  }, [view, navigate]);

  // ---- theme -------------------------------------------------------------
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('theme') || 'system'; } catch { return 'system'; } });
  useEffect(() => {
    try { localStorage.setItem('theme', theme); } catch { /* ignore */ }
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      const eff = theme === 'system' ? (mq.matches ? 'light' : 'dark') : theme;
      document.documentElement.setAttribute('data-theme', eff);
    };
    apply();
    if (theme !== 'system') return undefined;
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

  // ---- auth gate / contexts / data ---------------------------------------
  const gate = useAuthGate({ enabled: tokenOk, session, toast });
  const { configStatus, authOk } = gate;
  const contextKey = configStatus.currentContext || '';

  // useContexts routes to the Cluster overview itself (POST_SWITCH_VIEW).
  const { switchContext, afterSwitch, switching, switchTarget } = useContexts({ gate, toast });
  const { pins, togglePin } = usePins({ enabled: tokenOk && authOk, toast });

  // ---- context-switch loading screen ------------------------------------
  // Shown over <main> from the moment a switch starts (`switching`) until the
  // switch has settled (config status + auth re-checked) AND the Cluster view
  // has reported its first summary for the new context — capped at
  // SWITCH_OVERLAY_CAP_MS. Navigating away from the Cluster view also ends it.
  const [overlayAt, setOverlayAt] = useState(0); // start time of the current overlay, 0 = hidden
  const [summaryFor, setSummaryFor] = useState(null); // context name of the latest Cluster summary payload
  const onClusterSummary = useCallback((ctx) => setSummaryFor(ctx || ''), []);
  useEffect(() => {
    if (switching) { setOverlayAt(Date.now()); setSummaryFor(null); }
  }, [switching]);
  useEffect(() => {
    if (!overlayAt) return undefined;
    const t = setTimeout(() => setOverlayAt(0), SWITCH_OVERLAY_CAP_MS);
    return () => clearTimeout(t);
  }, [overlayAt]);
  const summaryReady = summaryFor != null && (!switchTarget || !summaryFor || summaryFor === switchTarget);
  useEffect(() => {
    if (overlayAt && !switching && (!switchTarget || summaryReady || view !== 'cluster')) setOverlayAt(0);
  }, [overlayAt, switching, switchTarget, summaryReady, view]);
  const showSwitchOverlay = overlayAt > 0 && authOk;

  const ns = useNamespaces({ enabled: tokenOk && authOk, contextKey, toast });
  const namespaces = ns.namespaces;

  const fanOut = useResourceFanOut({ enabled: tokenOk && authOk, contextKey, view, selectedNamespaces, allNamespaces: namespaces });
  const { allResources, partialErrors } = fanOut;
  const resources = useMemo(() => (isResourceView(view) ? (allResources[pluralKey(view)] || []) : null), [view, allResources]);
  const selectedResource = useMemo(() => {
    if (!selectedKey || !resources) return null;
    return resources.find((r) => r.name === selectedKey.name && (r.namespace || '') === (selectedKey.namespace || '')) || null;
  }, [selectedKey, resources]);

  // Surface backend `partial: true` results without blocking the view.
  const partialKey = partialErrors.map((e) => `${e.kind}:${e.namespace || ''}`).join('|');
  useEffect(() => {
    if (!partialKey) return;
    const kinds = Array.from(new Set(partialErrors.filter((e) => e.kind !== '*').map((e) => byPlural[e.kind]?.label || e.kind)));
    const nsFailed = Array.from(new Set(partialErrors.filter((e) => e.kind === '*').map((e) => e.namespace)));
    const parts = [];
    if (kinds.length) parts.push(kinds.join(', '));
    if (nsFailed.length) parts.push(`namespace${nsFailed.length > 1 ? 's' : ''} ${nsFailed.join(', ')}`);
    toast.warning(`Some resources could not be loaded: ${parts.join('; ')}`, { title: 'Partial results' });
  // partialKey summarises partialErrors; toast is stable
  }, [partialKey, partialErrors, toast]);

  // Optional integrations (Argo CD) on the active cluster.
  const argo = useRequest(
    ({ signal }) => getJson('/api/argocd/status', { signal }).then((d) => !!d?.installed),
    { deps: [contextKey], enabled: tokenOk && authOk, dedupeKey: `argocd-status:${contextKey}`, keepPreviousData: false },
  );
  const argocdInstalled = !!argo.data;

  // ---- refresh -----------------------------------------------------------
  const [refreshInterval, setRefreshInterval] = useState(() => { try { return localStorage.getItem('refreshInterval') || 'auto'; } catch { return 'auto'; } });
  useEffect(() => { try { localStorage.setItem('refreshInterval', refreshInterval); } catch { /* ignore */ } }, [refreshInterval]);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const refreshing = ns.refetching || fanOut.refetching;
  const nsRefetch = ns.refetch;
  const fanRefetch = fanOut.refetch;
  const fanActive = fanOut.active;
  const handleRefresh = useCallback(() => {
    setRefreshSignal((n) => n + 1);
    nsRefetch();
    if (fanActive) fanRefetch();
  }, [nsRefetch, fanRefetch, fanActive]);
  const refreshRef = useRef(handleRefresh); refreshRef.current = handleRefresh;
  useEffect(() => {
    const ms = refreshMs(refreshInterval);
    if (!ms || !authOk) return undefined;
    const id = setInterval(() => refreshRef.current(), ms);
    return () => clearInterval(id);
  }, [refreshInterval, authOk]);

  // ---- navigation helpers (stable) ----------------------------------------
  const nsQueryRef = useRef(nsQuery); nsQueryRef.current = nsQuery;
  const routeRef = useRef(route); routeRef.current = route;

  const goView = useCallback((key, params = []) => {
    navigate(key, params, { ns: nsQueryRef.current });
  }, [navigate]);

  const setSelectedNamespaces = useCallback((list) => {
    const r = routeRef.current;
    const keepParams = r.view === 'argocd' || r.view === 'security' || r.view === 'preferences' || r.view === 'customResources';
    navigate(r.view, keepParams ? r.params : [], { ...r.query, ns: nsToQuery(list) });
  }, [navigate]);

  const onSelectResource = useCallback((res) => {
    const r = routeRef.current;
    navigate(r.view, selectionToParams(res), r.query);
  }, [navigate]);

  const onSelectCustomResource = useCallback((sel) => {
    navigate('customResources', crSelectionToParams(sel), { ns: nsQueryRef.current });
  }, [navigate]);

  const onSubViewChange = useCallback((sub) => {
    const r = routeRef.current;
    if (r.params[0] === sub) return;
    navigate(r.view, [sub], r.query);
  }, [navigate]);

  const openPreferences = useCallback((section = 'general') => navigate('preferences', [section], {}), [navigate]);
  const onPrefSectionChange = useCallback((section) => navigate('preferences', [section], {}, { replace: true }), [navigate]);
  const closePreferences = useCallback(() => { if (canBack) back(); else navigate(DEFAULT_VIEW); }, [canBack, back, navigate]);
  const onFocusHandled = useCallback(() => {
    const r = routeRef.current;
    if (r.view === 'nodes' && r.params.length) navigate('nodes', [], r.query, { replace: true });
  }, [navigate]);
  const goEvents = useCallback(() => goView('events'), [goView]);
  const goAiSettings = useCallback(() => openPreferences('external-tools'), [openPreferences]);
  const goPrefs = useCallback(() => openPreferences('general'), [openPreferences]);

  // Cross-navigation used by tables, drawers and the topology/nodes views.
  const nav = useMemo(() => ({
    toNamespace: (namespace) => {
      if (!namespace) return;
      navigate(namespaceTargetView(routeRef.current.view), [], { ns: namespace });
    },
    toNode: (name) => { if (name) navigate('nodes', [name], { ns: nsQueryRef.current }); },
    toResource: ({ type, namespace, name }) => {
      if (!type || !name) return;
      navigate(type, selectionToParams({ namespace, name }), { ns: nsToQuery(namespace ? [namespace] : [ALL]) });
    },
    // Open the Pods view scoped to a workload. We rarely have the exact pod name
    // (e.g. Trivy attributes CVEs to the owning ReplicaSet), so filter the pod
    // list by the owner name — pods are named `<owner>-<hash>` and match.
    toPods: (namespace, nameFilter) => {
      navigate('pod', [], { ns: nsToQuery(namespace ? [namespace] : [ALL]), q: nameFilter || undefined });
    },
  }), [navigate]);

  // ---- overlays -----------------------------------------------------------
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [cloud, setCloud] = useState(null); // null | { kind: 'azure', mode: null|'az' } | { kind: 'aws' }
  // When the failing cluster uses kubelogin/azurecli, the fix is `az login`, so
  // the auth-error "Sign in to Azure" opens the modal in CLI-login mode.
  const openAzure = useCallback((mode) => setCloud({ kind: 'azure', mode: mode === 'az' ? 'az' : null }), []);
  const openAws = useCallback(() => setCloud({ kind: 'aws' }), []);
  const closeCloud = useCallback(() => setCloud(null), []);
  const { setForceConfigModal } = gate;
  const openLocal = useCallback(() => setForceConfigModal(true), [setForceConfigModal]);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closeShortcuts = useCallback(() => setShortcutsOpen(false), []);
  const { fetchConfigStatus, retryAuth } = gate;
  const onCloudImported = useCallback(async () => { await fetchConfigStatus(); retryAuth(); }, [fetchConfigStatus, retryAuth]);

  // Global keyboard: ⌘K palette, ? shortcuts, / focus search.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); setPaletteOpen((o) => !o); return; }
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (isEditable(e.target)) return;
      if (e.key === '?') { e.preventDefault(); setShortcutsOpen(true); }
      else if (e.key === '/') {
        const el = document.querySelector('#main input[type="search"], #main .ui-search-input');
        if (el) { e.preventDefault(); el.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- responsive nav drawer ---------------------------------------------
  const drawer = useNavDrawer({ routeKey: `${view}/${route.params.join('/')}` });

  // Searchable context picker (cluster menu "Search contexts…", palette "All
  // contexts…", desktop Clusters menu). Anything may also dispatch
  // OPEN_CONTEXTS_EVENT on window to open it.
  const [contextsOpen, setContextsOpen] = useState(false);
  const openContexts = useCallback(() => setContextsOpen(true), []);
  const closeContexts = useCallback(() => setContextsOpen(false), []);
  useEffect(() => {
    window.addEventListener(OPEN_CONTEXTS_EVENT, openContexts);
    return () => window.removeEventListener(OPEN_CONTEXTS_EVENT, openContexts);
  }, [openContexts]);

  // Desktop host (Electron main process) → renderer. The native "Clusters" menu
  // talks to the backend over HTTP itself and then dispatches
  //   window.dispatchEvent(new CustomEvent('kubepilot:host', { detail }))
  // with detail = { type: 'context-changed', context? } | { type: 'open-contexts' }
  //             | { type: 'add-cluster', provider: 'aws' | 'azure' }.
  const hostRef = useRef(null);
  hostRef.current = { afterSwitch, openContexts, openAws, openAzure };
  useEffect(() => {
    const onHost = (e) => {
      const d = e?.detail || {};
      const h = hostRef.current;
      if (!h) return;
      if (d.type === 'context-changed') h.afterSwitch(typeof d.context === 'string' ? d.context : undefined);
      else if (d.type === 'open-contexts') h.openContexts();
      else if (d.type === 'add-cluster') { if (d.provider === 'azure') h.openAzure(); else h.openAws(); }
    };
    window.addEventListener('kubepilot:host', onHost);
    return () => window.removeEventListener('kubepilot:host', onHost);
  }, []);

  // ---- document title + top-bar breadcrumb --------------------------------
  // Both come from the same facts: the view label, the namespace scope for
  // namespaced views, and (title only) the current context. The breadcrumb
  // shows the sub-view instead for views that have one (Argo CD, Security).
  const { title, crumb } = useMemo(() => {
    const label = byKey[view]?.label || 'KubePilot';
    const nsLabel = selectedNamespaces.includes(ALL) ? 'all namespaces' : selectedNamespaces.join(', ');
    const scoped = isResourceView(view) || view === 'overview' || view === 'events';
    const subItems = view === 'argocd' ? [...ARGO_ITEMS, ...ARGO_SETTINGS_ITEMS] : view === 'security' ? SECURITY_ITEMS : null;
    const subLabel = subItems ? subItems.find((i) => i.key === subView)?.label : null;
    const ctx = configStatus.currentContext;
    return {
      title: [label, scoped ? nsLabel : null, ctx].filter(Boolean).join(' · ') + ' — KubePilot',
      crumb: [label, scoped ? nsLabel : subLabel].filter(Boolean).join(' · '),
    };
  }, [view, subView, selectedNamespaces, configStatus.currentContext]);
  useDocumentTitle(title, { suffix: false });

  // ---- sidebar header row: [ cluster switcher ] [ ◀ ] [ ▶ ] -----------------
  // Rendered here (not in Navigation) so the sidebar stays free of cluster and
  // history logic; memoised so Navigation's React.memo still short-circuits.
  const { contexts: ctxList, contextsInfo, currentContext } = configStatus;
  const navHeaderExtra = useMemo(() => (
    <div className="nav-cluster-row">
      <ClusterSwitcher
        variant="sidebar"
        contexts={ctxList || []}
        contextsInfo={contextsInfo}
        currentContext={currentContext}
        pins={pins}
        onSwitch={switchContext}
        onTogglePin={togglePin}
        onOpenContexts={openContexts}
        onAddAws={openAws}
        onAddAzure={openAzure}
      />
      <div className="nav-hist" role="group" aria-label="History">
        <Tooltip content="Back">
          <button type="button" className="nav-hist-btn" disabled={!canBack} onClick={back} aria-label="Back"><Icon name="arrowLeft" size={16} /></button>
        </Tooltip>
        <Tooltip content="Forward">
          <button type="button" className="nav-hist-btn" disabled={!canForward} onClick={forward} aria-label="Forward"><Icon name="arrowRight" size={16} /></button>
        </Tooltip>
      </div>
    </div>
  ), [ctxList, contextsInfo, currentContext, pins, switchContext, togglePin, openContexts, openAws, openAzure, canBack, canForward, back, forward]);

  // ---- render -------------------------------------------------------------
  const { serverError, showConfigModal, showAuthError, checkingAuth, configChecked, autoRecovering } = gate;
  const assistantContext = useMemo(() => ({
    view,
    namespaces: selectedNamespaces,
    selected: selectedKey ? { type: view, namespace: selectedKey.namespace, name: selectedKey.name } : null,
  }), [view, selectedNamespaces, selectedKey]);
  const agentContext = useMemo(() => ({ currentContext: configStatus.currentContext }), [configStatus.currentContext]);
  const linkQuery = useMemo(() => (nsQuery ? { ns: nsQuery } : undefined), [nsQuery]);

  return (
    <div className="app-shell" data-nav={drawer.navState}>
      <TokenPrompt onSuccess={onTokenSuccess} />

      {tokenOk && authOk && (
        <TopBar
          crumb={crumb}
          onNotifications={goEvents}
          onConfigureAi={goAiSettings}
          onRefresh={handleRefresh}
          refreshing={refreshing}
          refreshInterval={refreshInterval}
          onSetRefreshInterval={setRefreshInterval}
          onOpenPalette={openPalette}
          navOpen={drawer.open}
          onToggleNav={drawer.toggle}
          navToggleRef={drawer.toggleRef}
        />
      )}

      {tokenOk && serverError && (
        <AuthErrorModal auth={serverError} onRetry={retryAuth} retrying={gate.authRetrying} />
      )}

      {tokenOk && !serverError && showConfigModal && (
        <KubeConfigModal
          defaultPath={configStatus.defaultPath}
          exists={configStatus.exists}
          onSubmit={gate.loadConfigFromPath}
          onAddAws={openAws}
          onAddAzure={openAzure}
          onClose={configStatus.loaded ? () => gate.setForceConfigModal(false) : undefined}
        />
      )}

      {tokenOk && !serverError && showAuthError && (
        <AuthErrorModal
          auth={gate.authState}
          onRetry={retryAuth}
          onChangeConfig={openLocal}
          retrying={gate.authRetrying}
          contexts={configStatus.contexts || []}
          contextsInfo={configStatus.contextsInfo}
          currentContext={configStatus.currentContext}
          onSwitchContext={switchContext}
          onAddAzure={openAzure}
          onAddAws={openAws}
        />
      )}

      {tokenOk && authOk && <Assistant context={assistantContext} />}

      {cloud?.kind === 'azure' && (
        <AzureIntegration initialLogin={cloud.mode} onClose={closeCloud} onImported={onCloudImported} />
      )}
      {cloud?.kind === 'aws' && (
        <AwsIntegration onClose={closeCloud} onImported={onCloudImported} />
      )}

      {tokenOk && authOk ? (
        <div className="layout-main">
          <Navigation
            ref={drawer.navRef}
            view={view}
            subView={subView}
            linkQuery={linkQuery}
            onNavigate={goView}
            crSelection={crSelection}
            onSelectCustomResource={onSelectCustomResource}
            argocdInstalled={argocdInstalled}
            onOpenPreferences={goPrefs}
            headerExtra={navHeaderExtra}
          />
          <div className="nav-backdrop" onClick={drawer.close} aria-hidden="true" />

          <div className="content-col">
            <main id="main" className="app-main" tabIndex={-1} aria-busy={showSwitchOverlay || undefined}>
              {showSwitchOverlay && (
                <LoadingScreen overlay context={switchTarget || configStatus.currentContext} />
              )}
              <ErrorBoundary resetKey={view} title="This view crashed">
                <ViewOutlet
                  view={view}
                  route={route}
                  navigate={navigate}
                  setQuery={setQuery}
                  refreshSignal={refreshSignal}
                  onRefresh={handleRefresh}
                  configStatus={configStatus}
                  theme={theme}
                  onSetTheme={setTheme}
                  namespaces={namespaces}
                  selectedNamespaces={selectedNamespaces}
                  onNamespaceChange={setSelectedNamespaces}
                  allResources={allResources}
                  resources={resources}
                  loading={fanOut.loading}
                  refetching={fanOut.refetching}
                  error={fanOut.error}
                  partialErrors={partialErrors}
                  selectedResource={selectedResource}
                  selectedKey={selectedKey}
                  onSelectResource={onSelectResource}
                  focusNode={focusNode}
                  onFocusHandled={onFocusHandled}
                  crSelection={crSelection}
                  onSelectCustomResource={onSelectCustomResource}
                  subView={subView}
                  onSubViewChange={onSubViewChange}
                  prefSection={prefSection}
                  onPrefSectionChange={onPrefSectionChange}
                  onClosePreferences={closePreferences}
                  onChangeConfig={openLocal}
                  onAddAzure={openAzure}
                  onAddAws={openAws}
                  onResourceTypeChange={goView}
                  nav={nav}
                  onClusterSummary={onClusterSummary}
                />
              </ErrorBoundary>
            </main>
            <ErrorBoundary title="The agent panel crashed">
              <AgentPanel context={agentContext} />
            </ErrorBoundary>
          </div>
        </div>
      ) : !tokenOk ? (
        <div className="loading-state" />
      ) : !configChecked ? (
        <div className="loading-state">
          <LoadingScreen hint="Loading kubeconfig…" />
        </div>
      ) : checkingAuth ? (
        <div className="loading-state">
          <LoadingScreen
            context={configStatus.currentContext}
            hint={autoRecovering ? 'Reconnecting — refreshing credentials…' : 'Checking cluster authentication…'}
          />
        </div>
      ) : (
        // A modal (config / auth / server error) is overlaid above; keep a
        // neutral backdrop underneath it.
        <div className="loading-state" />
      )}

      {tokenOk && authOk && (
        <CommandPalette
          open={paletteOpen}
          onClose={closePalette}
          onNavigate={goView}
          contexts={configStatus.contexts || []}
          currentContext={configStatus.currentContext}
          onSwitchContext={switchContext}
          onOpenContexts={openContexts}
          onOpenPreferences={goPrefs}
          onRefresh={handleRefresh}
          onSetTheme={setTheme}
          argocdInstalled={argocdInstalled}
        />
      )}
      {tokenOk && authOk && (
        <ContextPickerModal
          open={contextsOpen}
          onClose={closeContexts}
          contexts={configStatus.contexts || []}
          contextsInfo={configStatus.contextsInfo}
          currentContext={configStatus.currentContext}
          onChange={switchContext}
          onAddAws={openAws}
          onAddAzure={openAzure}
          onAddLocal={openLocal}
        />
      )}
      <ShortcutsSheet open={shortcutsOpen} onClose={closeShortcuts} />
    </div>
  );
}

export default App;
