import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import YamlViewer from './YamlViewer';
import LogsViewer from './LogsViewer';
import DeploymentLogs from './DeploymentLogs';
import TerminalViewer from './TerminalViewer';
import Events from './Events';
import NamespaceMultiSelect from './NamespaceMultiSelect';
import ResourceDrawer from './ResourceDrawer';
import Icon from './Icons';
import { useToast } from './Toast';
import DataTable from './ui/DataTable';
import SearchBox from './ui/SearchBox';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import ErrorState from './ui/ErrorState';
import Modal, { ConfirmModal } from './ui/Modal';
import useRequest from '../hooks/useRequest';
import useDocumentTitle from '../hooks/useDocumentTitle';
import { getJson, postJson, del, p, errorMessage } from '../lib/api';
import { labelFor, isClusterScoped } from '../lib/kinds';
import { pluralize } from '../lib/format';
import { askLabel, aiToolIcon } from '../aiConfig';
import { columnsFor, rowToneFor } from './resources/columns';
import { aiActionsFor, buildAiPrompt, askAssistant } from './resources/aiPrompts';

// workloads whose replica count can be scaled / rolled out
export const SCALABLE = new Set(['deployment', 'statefulSet', 'replicaSet', 'replicationController']);
export const RESTARTABLE = new Set(['deployment', 'statefulSet', 'daemonSet']);
// kinds with a Logs action (pods directly; deployments across their pods)
export const LOGGABLE = new Set(['pod', 'deployment']);
// kinds whose deletion requires typing the name even for a single item
const NAME_TYPED_KINDS = new Set(['namespaces', 'namespace', 'nodes', 'node']);

const TAB_META = {
  logs: { icon: 'logs', label: 'Logs' },
  terminal: { icon: 'terminal', label: 'Terminal' },
  configuration: { icon: 'configuration', label: 'YAML' },
};

// Types shown as tabs at the top of the workloads viewer (Config/Network/etc.
// are navigated from the sidebar and get no tab strip).
export const TAB_KEYS = ['overview', 'pod', 'service', 'deployment', 'statefulSet', 'daemonSet', 'replicaSet', 'replicationController', 'job', 'cronJob', 'events'];

const SCALE_MIN = 0;
const SCALE_MAX = 10000;
export function validateReplicas(v) {
  if (v === '' || v == null) return 'Enter a replica count.';
  const n = Number(v);
  if (!Number.isInteger(n)) return 'Replicas must be a whole number.';
  if (n < SCALE_MIN || n > SCALE_MAX) return `Replicas must be between ${SCALE_MIN} and ${SCALE_MAX}.`;
  return null;
}

const rowKey = (r) => `${r.namespace || ''}/${r.name}`;
const isEditable = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

export default function ResourceViewer({
  resourceType,
  resources = [],
  loading = false,
  refetching = false,
  error = null,
  partialErrors,
  namespaces = [],
  selectedNamespaces = ['all'],
  onNamespaceChange,
  selectedResource,
  onSelectResource,
  onOpenLogs,
  onOpenTerminal,
  onOpenYaml,
  onAction,
  route,
  navigate,
  refreshSignal = 0,
  context,
  // legacy props (still honoured)
  searchQuery,
  onSearchChange,
  totalCount,
  onResourceTypeChange,
  onNavigate,
  onRefresh,
}) {
  const toast = useToast();
  const uid = useId();
  const { label, icon, singular } = labelFor(resourceType);
  useDocumentTitle(label);

  const namespace = selectedNamespaces.includes('all') || selectedNamespaces.length !== 1 ? 'all' : selectedNamespaces[0];
  const namespaceKey = selectedNamespaces.join(',');

  // ---- search (route.query.q is the source of truth when routing is wired) ----
  const routeQ = route?.query?.q;
  const [q, setQ] = useState(routeQ ?? searchQuery ?? '');
  const pushedQ = useRef(routeQ ?? searchQuery ?? '');
  const debounce = useRef(null);
  const searchRef = useRef(null);
  useEffect(() => {
    const external = routeQ ?? searchQuery;
    if (external !== undefined && external !== pushedQ.current) { pushedQ.current = external; setQ(external); }
  }, [routeQ, searchQuery]);
  useEffect(() => () => clearTimeout(debounce.current), []);
  const onSearch = (v) => {
    setQ(v);
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      pushedQ.current = v;
      onSearchChange?.(v);
      if (navigate && route) navigate(route.view, route.params, { ...route.query, q: v || undefined }, { replace: true });
    }, 150);
  };
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || isEditable(e.target)) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return resources;
    return resources.filter((r) => (r.name || '').toLowerCase().includes(needle) || (r.namespace || '').toLowerCase().includes(needle));
  }, [resources, q]);

  // ---- selection (checkboxes) ----
  const [selected, setSelected] = useState(() => new Set());
  useEffect(() => { setSelected(new Set()); }, [resourceType, namespaceKey]);
  const toggleSelect = useCallback((_r, key) => setSelected((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; }), []);
  const toggleAll = useCallback((checked, sortedRows) => setSelected(checked ? new Set(sortedRows.map(rowKey)) : new Set()), []);
  const selectedResources = () => resources.filter((r) => selected.has(rowKey(r)));

  // ---- bottom panel tabs (used when the shell doesn't own logs/terminal/yaml) ----
  const [tabs, setTabs] = useState([]);
  const [activeTabId, setActiveTabId] = useState(null);
  const openTab = useCallback((type, res, container) => {
    if (!res) return;
    const id = `${type}:${resourceType}:${res.namespace || ''}/${res.name}${container ? `:${container}` : ''}`;
    setTabs((prev) => (prev.some((t) => t.id === id) ? prev : [...prev, { id, type, resource: res, resourceType, container }]));
    setActiveTabId(id);
  }, [resourceType]);
  const closeTab = (id) => {
    const remaining = tabs.filter((t) => t.id !== id);
    setTabs(remaining);
    if (activeTabId === id) setActiveTabId(remaining.length ? remaining[remaining.length - 1].id : null);
  };
  const openLogs = useCallback((res, container) => (onOpenLogs ? onOpenLogs(container ? { ...res, container } : res) : openTab('logs', res, container)), [onOpenLogs, openTab]);
  const openTerminal = (res) => (onOpenTerminal ? onOpenTerminal(res) : openTab('terminal', res));
  const openYaml = (res) => (onOpenYaml ? onOpenYaml(res) : openTab('configuration', res));

  // Parent refresh after a mutation (new contract: onAction(result); legacy: onRefresh()).
  const requestRefresh = (result) => { onAction?.(result); onRefresh?.(); };

  // ---- live pod metrics for the CPU / Memory columns ----
  const { data: metricsData } = useRequest(
    ({ signal }) => getJson(p('api', 'metrics', 'pods'), { signal }),
    { deps: [refreshSignal, context], enabled: resourceType === 'pod', pollMs: 15000, dedupeKey: 'metrics:pods' },
  );
  const podMetrics = resourceType === 'pod' ? metricsData?.metrics : undefined;

  const onRowLogs = LOGGABLE.has(resourceType) ? openLogs : undefined;
  const columns = useMemo(() => columnsFor(resourceType, { icon, onNavigate, podMetrics, onOpenLogs: onRowLogs }), [resourceType, icon, onNavigate, podMetrics, onRowLogs]);
  const getRowTone = useMemo(() => rowToneFor(resourceType), [resourceType]);

  // ---- "Ask <AI tool>" ----
  const askAi = (res, action) => {
    toast.info(`${res.name} · ${action}`, { title: askLabel() });
    askAssistant(buildAiPrompt(action, { kindLabel: singular, name: res.name, namespace: res.namespace }));
  };
  const askAiItem = (res) => ({
    icon: aiToolIcon(), label: askLabel(),
    children: aiActionsFor(resourceType).map((a) => ({ icon: a.icon, label: a.label, onSelect: () => askAi(res, a.key) })),
  });

  // ---- actions (modals) ----
  const [actionModal, setActionModal] = useState(null); // { type, resource|targets, step, replicas, busy, error }
  const openDelete = (res) => setActionModal({ type: 'delete', resource: res, step: 1 });
  const openScale = (res) => setActionModal({ type: 'scale', resource: res, replicas: String(res.replicas ?? 1) });
  const openRestart = (res) => setActionModal({ type: 'restart', resource: res });

  const menuItems = (res) => {
    const items = [
      { icon: 'details', label: 'Details', onSelect: () => onSelectResource?.(res) },
      askAiItem(res),
    ];
    if (resourceType === 'pod') {
      const cns = res.containerNames || [];
      if (cns.length > 1) items.push({ icon: 'logs', label: 'Logs', children: cns.map((c) => ({ icon: 'box', label: c, onSelect: () => openLogs(res, c) })) });
      else items.push({ icon: 'logs', label: 'Logs', onSelect: () => openLogs(res, cns[0]) });
      items.push({ icon: 'terminal', label: 'Terminal', onSelect: () => openTerminal(res) });
    } else if (LOGGABLE.has(resourceType)) {
      items.push({ icon: 'logs', label: 'Logs', onSelect: () => openLogs(res) });
    }
    items.push({ icon: 'configuration', label: 'Edit YAML', onSelect: () => openYaml(res) });
    if (SCALABLE.has(resourceType)) items.push({ icon: 'scale', label: 'Scale…', onSelect: () => openScale(res) });
    if (RESTARTABLE.has(resourceType)) items.push({ icon: 'refresh', label: 'Restart', onSelect: () => openRestart(res) });
    items.push({ divider: true });
    items.push({ icon: 'delete', label: 'Delete…', danger: true, onSelect: () => openDelete(res) });
    return items;
  };

  // namespace path segment for a resource's write endpoint ('-' for cluster-scoped)
  const nsOf = (res) => res.namespace || (isClusterScoped(resourceType) ? '-' : (namespace !== 'all' ? namespace : '-'));
  const endpoint = (kind, res) => p('api', kind, nsOf(res), resourceType, res.name);

  const runAction = async () => {
    if (!actionModal || actionModal.busy) return;
    const { type, resource: res } = actionModal;
    if (type === 'scale' && validateReplicas(actionModal.replicas)) return;
    setActionModal((m) => ({ ...m, busy: true, error: null }));
    try {
      if (type === 'delete') {
        await del(endpoint('resource', res));
        toast.success(`${res.name} deleted`, { title: 'Delete' });
        if (selectedResource && rowKey(selectedResource) === rowKey(res)) onSelectResource?.(null);
      } else if (type === 'scale') {
        const replicas = Number(actionModal.replicas);
        await postJson(endpoint('scale', res), { replicas });
        toast.success(`Scaled ${res.name} to ${replicas}`, { title: 'Scale' });
      } else if (type === 'restart') {
        await postJson(endpoint('restart', res));
        toast.success(`Restart triggered for ${res.name}`, { title: 'Restart' });
      }
      setActionModal(null);
      requestRefresh({ type, resourceType, resource: res, ok: true });
    } catch (err) {
      toast.error(errorMessage(err, 'Action failed'), { title: 'Error' });
      setActionModal((m) => (m ? { ...m, busy: false, error: errorMessage(err, 'Action failed') } : m));
    }
  };

  const runBulk = async () => {
    if (!actionModal || actionModal.busy) return;
    const { type, targets = [] } = actionModal;
    setActionModal((m) => ({ ...m, busy: true, error: null }));
    let ok = 0; let failed = 0; let lastErr = '';
    for (const res of targets) {
      try {
        if (type === 'bulkDelete') await del(endpoint('resource', res));
        else if (type === 'bulkRestart') await postJson(endpoint('restart', res));
        ok += 1;
      } catch (err) { failed += 1; lastErr = errorMessage(err, 'failed'); }
    }
    const verb = type === 'bulkDelete' ? 'Deleted' : 'Restarted';
    if (failed === 0) toast.success(`${verb} ${ok} ${pluralize(ok, 'item')}`, { title: 'Bulk action' });
    else toast.error(`${verb} ${ok}, ${failed} failed — ${lastErr}`, { title: 'Bulk action' });
    setActionModal(null);
    setSelected(new Set());
    if (type === 'bulkDelete') onSelectResource?.(null);
    requestRefresh({ type, resourceType, targets, ok, failed });
  };

  // ---- type tabs (tablist with arrow-key navigation) ----
  const isTabbed = TAB_KEYS.includes(resourceType);
  const selectType = (key) => { if (onResourceTypeChange) onResourceTypeChange(key); else navigate?.(key); };
  const onTabKeyDown = (e, idx) => {
    const n = TAB_KEYS.length;
    let next = null;
    if (e.key === 'ArrowRight') next = (idx + 1) % n;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    if (next == null) return;
    e.preventDefault();
    const key = TAB_KEYS[next];
    e.currentTarget.parentElement?.querySelector(`[data-tab="${key}"]`)?.focus();
    selectType(key);
  };

  const tabId = (key) => `${uid}-tab-${key}`;
  const total = totalCount ?? resources.length;
  const nsLabel = namespace === 'all' ? 'all namespaces' : `namespace ${namespace}`;
  const emptyHint = q
    ? `No ${label.toLowerCase()} match “${q}” in ${nsLabel}. Clear the search or pick another namespace.`
    : `No ${label.toLowerCase()} in ${nsLabel}. Try selecting another namespace.`;

  const scaleError = actionModal?.type === 'scale' ? validateReplicas(actionModal.replicas) : null;
  const scaleErrId = `${uid}-scale-err`;
  const scaleInputId = `${uid}-scale-input`;

  return (
    <div className="resource-viewer">
      {isTabbed && (
        <div className="resource-tabs" role="tablist" aria-label="Resource types">
          {TAB_KEYS.map((key, idx) => {
            const active = resourceType === key;
            const meta = labelFor(key);
            return (
              <button
                key={key}
                type="button"
                role="tab"
                id={tabId(key)}
                data-tab={key}
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                className={`resource-tab${active ? ' active' : ''}`}
                onClick={() => selectType(key)}
                onKeyDown={(e) => onTabKeyDown(e, idx)}
              >
                <Icon name={meta.icon} size={15} />
                {meta.label}
              </button>
            );
          })}
        </div>
      )}

      <div className="resource-header">
        <div>
          <h1 className="resource-title">
            <Icon name={icon} size={18} />
            {label}
          </h1>
          <span className="resource-count">
            {total} {pluralize(total, 'item')}{selected.size ? ` · ${selected.size} selected` : ''}
          </span>
          <span className="resource-refreshing" aria-live="polite" role="status">{refetching ? 'Refreshing…' : ''}</span>
        </div>
        <div className="resource-controls">
          <NamespaceMultiSelect namespaces={namespaces} selected={selectedNamespaces} onChange={(next) => onNamespaceChange?.(next)} />
          <SearchBox
            ref={searchRef}
            value={q}
            onChange={onSearch}
            ariaLabel={`Search ${label}`}
            placeholder={`Search ${label}…`}
            shortcut="/"
          />
        </div>
      </div>

      {partialErrors?.length > 0 && (
        <div className="partial-banner" role="status">
          <Icon name="warning" size={14} />
          <span>
            Some kinds could not be loaded: {partialErrors.map((e) => `${e.kind}${e.error ? ` (${e.error})` : ''}`).join('; ')}
          </span>
        </div>
      )}

      <div
        className="resource-table-wrapper"
        role={isTabbed ? 'tabpanel' : undefined}
        aria-labelledby={isTabbed ? tabId(resourceType) : undefined}
      >
        {resourceType === 'events' ? (
          <Events namespace={namespace} refreshSignal={refreshSignal} onNavigate={onNavigate} />
        ) : error && resources.length === 0 ? (
          <ErrorState error={error} title={`Couldn't load ${label.toLowerCase()}`} onRetry={() => requestRefresh({ type: 'retry', resourceType })} busy={refetching} />
        ) : (
          <>
            {error && <ErrorState compact error={error} title={`Latest refresh failed — showing previous ${label.toLowerCase()}`} onRetry={() => requestRefresh({ type: 'retry', resourceType })} busy={refetching} />}
            <DataTable
              caption={`${label} in ${nsLabel}`}
              columns={columns}
              rows={rows}
              rowKey={rowKey}
              rowName={(r) => r.name}
              activeKey={selectedResource ? rowKey(selectedResource) : null}
              onRowActivate={(r) => onSelectResource?.(r)}
              rowActions={menuItems}
              selected={selected}
              onToggleSelect={toggleSelect}
              onToggleAll={toggleAll}
              getRowTone={getRowTone}
              loading={loading}
              refetching={refetching}
              emptyState={<EmptyState icon={icon} title={`No ${label.toLowerCase()} found`} hint={emptyHint} />}
              initialSort={{ key: 'name', dir: 'asc' }}
              storageKey={`rv:${resourceType}`}
            />
          </>
        )}
      </div>

      {tabs.length > 0 && (
        <div className="bottom-panel">
          <div className="bottom-panel-tabs" role="tablist" aria-label="Open panels">
            {tabs.map((t) => {
              const meta = TAB_META[t.type];
              const title = `${meta.label}: ${t.resource.name}${t.container ? ` · ${t.container}` : ''}`;
              const active = activeTabId === t.id;
              return (
                <div key={t.id} className={`tab-chip${active ? ' active' : ''}`}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-controls={`${uid}-pane-${t.id}`}
                    tabIndex={active ? 0 : -1}
                    className="tab-chip-btn"
                    title={title}
                    onClick={() => setActiveTabId(t.id)}
                  >
                    <Icon name={meta.icon} size={14} />
                    <span className="tab-chip-label">
                      {t.resource.name}{t.container ? <span className="tab-chip-sub"> · {t.container}</span> : null}
                    </span>
                  </button>
                  <button type="button" className="tab-chip-close" aria-label={`Close ${title}`} onClick={() => closeTab(t.id)}>
                    <Icon name="close" size={12} />
                  </button>
                </div>
              );
            })}
            <Button variant="ghost" size="sm" iconOnly icon="close" ariaLabel="Close all panels" className="bottom-panel-toggle" onClick={() => { setTabs([]); setActiveTabId(null); }} />
          </div>

          <div className="bottom-panel-content">
            {tabs.map((t) => (
              <div key={t.id} id={`${uid}-pane-${t.id}`} role="tabpanel" className="tab-pane" hidden={activeTabId !== t.id}>
                {t.type === 'logs' && t.resourceType === 'deployment' && (
                  <DeploymentLogs namespace={t.resource.namespace} name={t.resource.name} onClose={() => closeTab(t.id)} />
                )}
                {t.type === 'logs' && t.resourceType !== 'deployment' && (
                  <LogsViewer
                    namespace={t.resource.namespace}
                    pod={t.resource.name}
                    containers={t.resource.containerNames || []}
                    initialContainer={t.container}
                    onClose={() => closeTab(t.id)}
                  />
                )}
                {t.type === 'terminal' && (
                  <TerminalViewer namespace={t.resource.namespace} pod={t.resource.name} container={t.resource.container} onClose={() => closeTab(t.id)} />
                )}
                {t.type === 'configuration' && (
                  <YamlViewer
                    namespace={t.resource.namespace}
                    kind={t.resourceType}
                    name={t.resource.name}
                    onClose={() => closeTab(t.id)}
                    onApplied={() => requestRefresh({ type: 'apply', resourceType: t.resourceType, resource: t.resource, ok: true })}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {selectedResource && (
        <ResourceDrawer
          resource={selectedResource}
          namespace={namespace}
          resourceType={resourceType}
          onClose={() => onSelectResource?.(null)}
          onOpenLogs={(r) => openLogs(r)}
          onOpenTerminal={(r) => openTerminal(r)}
          onOpenYaml={(r) => openYaml(r)}
          onDelete={(r) => openDelete(r)}
          onScale={SCALABLE.has(resourceType) ? (r) => openScale(r) : undefined}
          onRestart={RESTARTABLE.has(resourceType) ? (r) => openRestart(r) : undefined}
          onNavigate={onNavigate}
          refreshSignal={refreshSignal}
        />
      )}

      {selected.size > 0 && (
        <div className="bulk-bar" role="region" aria-label="Bulk actions">
          <span className="bulk-count">{selected.size} selected</span>
          {RESTARTABLE.has(resourceType) && (
            <button type="button" className="bulk-btn" onClick={() => setActionModal({ type: 'bulkRestart', targets: selectedResources(), step: 1 })}>
              <Icon name="refresh" size={14} /> Restart
            </button>
          )}
          <button type="button" className="bulk-btn danger" onClick={() => setActionModal({ type: 'bulkDelete', targets: selectedResources(), step: 1 })}>
            <Icon name="delete" size={14} /> Delete
          </button>
          <button type="button" className="bulk-btn ghost" aria-label="Clear selection" onClick={() => setSelected(new Set())}>
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      {/* ---- single-item delete (two-step) ---- */}
      {actionModal?.type === 'delete' && (
        <ConfirmModal
          open
          danger
          icon="delete"
          title={`Delete ${singular}`}
          busy={actionModal.busy}
          message={actionModal.step === 2
            ? <><b>Are you absolutely sure?</b> This permanently deletes <b>{actionModal.resource.name}</b>{actionModal.resource.namespace ? <> in <b>{actionModal.resource.namespace}</b></> : null} and cannot be undone.</>
            : <>Delete <b>{actionModal.resource.name}</b>{actionModal.resource.namespace ? <> in <b>{actionModal.resource.namespace}</b></> : null}? This cannot be undone.</>}
          confirmLabel={actionModal.step === 2 ? 'Yes, delete' : 'Delete'}
          requireTyped={actionModal.step === 2 && NAME_TYPED_KINDS.has(resourceType) ? actionModal.resource.name : undefined}
          onConfirm={() => (actionModal.step === 2 ? runAction() : setActionModal((m) => ({ ...m, step: 2 })))}
          onCancel={() => setActionModal(null)}
        >
          {actionModal.error && <p className="ui-modal-error" role="alert">{actionModal.error}</p>}
        </ConfirmModal>
      )}

      {/* ---- rollout restart ---- */}
      {actionModal?.type === 'restart' && (
        <ConfirmModal
          open
          icon="refresh"
          title="Rollout restart"
          busy={actionModal.busy}
          message={<>Trigger a rolling restart of <b>{actionModal.resource.name}</b>?</>}
          confirmLabel="Restart"
          onConfirm={runAction}
          onCancel={() => setActionModal(null)}
        >
          {actionModal.error && <p className="ui-modal-error" role="alert">{actionModal.error}</p>}
        </ConfirmModal>
      )}

      {/* ---- scale ---- */}
      {actionModal?.type === 'scale' && (
        <Modal
          open
          icon="scale"
          size="sm"
          title={`Scale ${actionModal.resource.name}`}
          onClose={actionModal.busy ? undefined : () => setActionModal(null)}
          footer={(
            <>
              <Button variant="secondary" onClick={() => setActionModal(null)} disabled={actionModal.busy}>Cancel</Button>
              <Button variant="primary" onClick={runAction} disabled={!!scaleError} busy={actionModal.busy}>Scale</Button>
            </>
          )}
        >
          <form onSubmit={(e) => { e.preventDefault(); runAction(); }}>
            <label htmlFor={scaleInputId} className="ui-modal-label">Replicas</label>
            <input
              id={scaleInputId}
              className="ui-modal-input"
              type="number"
              inputMode="numeric"
              min={SCALE_MIN}
              max={SCALE_MAX}
              step={1}
              data-autofocus
              value={actionModal.replicas}
              onChange={(e) => setActionModal((m) => ({ ...m, replicas: e.target.value }))}
              aria-invalid={scaleError ? 'true' : undefined}
              aria-describedby={scaleError || actionModal.error ? scaleErrId : undefined}
            />
            {(scaleError || actionModal.error) && (
              <p id={scaleErrId} className="ui-modal-error" role="alert">{scaleError || actionModal.error}</p>
            )}
          </form>
        </Modal>
      )}

      {/* ---- bulk delete / restart (two-step) ---- */}
      {(actionModal?.type === 'bulkDelete' || actionModal?.type === 'bulkRestart') && (() => {
        const n = actionModal.targets.length;
        const items = `${n} ${pluralize(n, 'item')}`;
        const isDelete = actionModal.type === 'bulkDelete';
        const second = actionModal.step === 2;
        return (
          <ConfirmModal
            open
            danger={isDelete}
            icon={isDelete ? 'delete' : 'refresh'}
            title={isDelete ? `Delete ${n} ${pluralize(n, singular)}` : `Restart ${n} ${pluralize(n, singular)}`}
            busy={actionModal.busy}
            message={isDelete
              ? (second
                ? <><b>Are you absolutely sure?</b> This permanently deletes <b>{items}</b> and cannot be undone.</>
                : <>Delete <b>{items}</b>? This cannot be undone.</>)
              : (second
                ? <><b>Confirm the restart.</b> A rolling restart of <b>{items}</b> will be triggered now.</>
                : <>Trigger a rolling restart of <b>{items}</b>?</>)}
            confirmLabel={isDelete ? (second ? 'Yes, delete' : 'Delete') : (second ? 'Yes, restart' : 'Restart')}
            requireTyped={isDelete && second && n > 1 ? 'delete' : undefined}
            onConfirm={() => (second ? runBulk() : setActionModal((m) => ({ ...m, step: 2 })))}
            onCancel={() => setActionModal(null)}
          >
            {actionModal.error && <p className="ui-modal-error" role="alert">{actionModal.error}</p>}
          </ConfirmModal>
        );
      })()}
    </div>
  );
}
