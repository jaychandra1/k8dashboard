import React, { forwardRef, useCallback, useEffect, useMemo, useState } from 'react';
import Icon from './Icons';
import CustomResourceTree from './CustomResourceTree';
import ContextSelector from './ContextSelector';
import { NAV_GROUPS, byKey, typesInGroup } from '../lib/kinds';
import { buildHash } from '../hooks/useHashRoute';

// Sub-views of the Argo CD / Security Center views (mirrored as sidebar items).
export const ARGO_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', icon: 'overview' },
  { key: 'applications', label: 'Applications', icon: 'argocd' },
  { key: 'view', label: 'View', icon: 'topology' },
  { key: 'appsets', label: 'Application Sets', icon: 'box' },
  { key: 'projects', label: 'Projects', icon: 'accessControl' },
];
export const ARGO_SETTINGS_ITEMS = [
  { key: 'repositories', label: 'Repositories', icon: 'git' },
  { key: 'clusters', label: 'Clusters', icon: 'cluster' },
];
export const SECURITY_ITEMS = [
  { key: 'overview', label: 'Overview', icon: 'overview' },
  { key: 'images', label: 'Images', icon: 'box' },
  { key: 'resources', label: 'Resources', icon: 'configuration' },
  { key: 'roles', label: 'Roles', icon: 'accessControl' },
];

const STORE_KEY = 'navExpanded';
const DEFAULT_EXPANDED = { workloads: true, network: false, storage: false, config: false, argocd: false, argocdSettings: false, security: false };
const loadExpanded = () => {
  try { const v = JSON.parse(localStorage.getItem(STORE_KEY)); return v && typeof v === 'object' ? { ...DEFAULT_EXPANDED, ...v } : DEFAULT_EXPANDED; } catch { return DEFAULT_EXPANDED; }
};

const isPlainClick = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/**
 * Primary sidebar. Every item is a real link (`<a href="#/…">`, so middle-click
 * / open-in-new-tab work) built from the resource registry; the active one has
 * `aria-current="page"`. Sections are `<button aria-expanded>` + `<ul>`.
 *
 * Props: { configStatus, onSwitchContext, view, subView, linkQuery, onNavigate(view, params?),
 *          crSelection, onSelectCustomResource, argocdInstalled, onAddAzure, onAddAws, onAddLocal, onOpenPreferences }
 */
const Navigation = forwardRef(function Navigation({
  configStatus,
  onSwitchContext,
  view,
  subView,
  linkQuery,
  onNavigate,
  crSelection,
  onSelectCustomResource,
  argocdInstalled,
  onAddAzure,
  onAddAws,
  onAddLocal,
  onOpenPreferences,
}, ref) {
  const [expanded, setExpanded] = useState(loadExpanded);
  useEffect(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify(expanded)); } catch { /* ignore */ } }, [expanded]);
  const toggle = useCallback((key) => setExpanded((prev) => ({ ...prev, [key]: !prev[key] })), []);

  // Auto-expand the section that contains the active view.
  const activeGroup = view === 'argocd' ? 'argocd' : view === 'security' ? 'security' : (view === 'overview' ? 'workloads' : byKey[view]?.group);
  useEffect(() => {
    if (!activeGroup || !(activeGroup in DEFAULT_EXPANDED)) return;
    setExpanded((prev) => (prev[activeGroup] ? prev : { ...prev, [activeGroup]: true }));
    if (view === 'argocd' && ARGO_SETTINGS_ITEMS.some((i) => i.key === subView)) {
      setExpanded((prev) => (prev.argocdSettings ? prev : { ...prev, argocdSettings: true }));
    }
  }, [activeGroup, view, subView]);

  const query = linkQuery || undefined;
  const hrefFor = useCallback((key, params) => buildHash(key, params, query), [query]);
  const go = useCallback((e, key, params) => {
    if (!isPlainClick(e)) return; // let the browser handle new-tab / new-window
    e.preventDefault();
    onNavigate?.(key, params);
  }, [onNavigate]);

  const groups = useMemo(() => {
    const cluster = typesInGroup('cluster').filter((t) => t.key !== 'overview');
    const collapsible = NAV_GROUPS.filter((g) => ['workloads', 'network', 'storage', 'config'].includes(g.key)).map((g) => ({
      ...g,
      items: g.key === 'workloads' ? [byKey.overview, ...typesInGroup('workloads')] : typesInGroup(g.key),
    }));
    const other = typesInGroup('other').filter((t) => t.key !== 'customResources');
    return { cluster, collapsible, other };
  }, []);

  const renderLink = (t, { simple = false, params, active, key } = {}) => {
    const isActive = active ?? (view === t.key);
    return (
      <li key={key || t.key}>
        <a
          href={hrefFor(t.key, params)}
          className={`nav-item ${simple ? 'simple' : ''} ${isActive ? 'active' : ''}`.replace(/\s+/g, ' ').trim()}
          aria-current={isActive ? 'page' : undefined}
          onClick={(e) => go(e, t.key, params)}
        >
          <Icon name={t.icon} size={simple ? 16 : 15} className="nav-lead-icon" />
          {t.label}
        </a>
      </li>
    );
  };

  const renderSection = (key, label, items, { icon, nested = false, extra = null } = {}) => {
    const open = !!expanded[key];
    const listId = `nav-section-${key}`;
    return (
      <div className={nested ? 'nav-subsection' : 'nav-section'} key={key}>
        <button
          type="button"
          className={`nav-section-title ${nested ? 'nested' : ''}`.trim()}
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => toggle(key)}
        >
          <span className={`nav-section-chevron ${open ? 'open' : ''}`} aria-hidden="true">
            <Icon name="chevronRight" size={13} strokeWidth={2.2} />
          </span>
          {icon && <Icon name={icon} size={15} className="nav-lead-icon" />}
          {label}
        </button>
        {open && (
          <ul id={listId} className="nav-items">
            {items}
            {extra}
          </ul>
        )}
      </div>
    );
  };

  const subItems = (parent, list) => list.map((it) => renderLink(
    { key: parent, label: it.label, icon: it.icon },
    { params: [it.key], active: view === parent && subView === it.key, key: `${parent}:${it.key}` },
  ));

  return (
    <nav ref={ref} id="primary-nav" className="nav-sidebar" aria-label="Primary">
      <div className="nav-header">
        <div className="nav-brand">
          <div className="nav-brand-logo" aria-hidden="true">
            <Icon name="logo" size={19} strokeWidth={1.8} />
          </div>
          <div className="nav-brand-text">
            <span className="nav-brand-title">k8sight</span>
            <span className="nav-brand-sub">
              Kubernetes
              {typeof __APP_VERSION__ !== 'undefined' && (
                <span className="nav-brand-version">v{__APP_VERSION__}</span>
              )}
            </span>
          </div>
          <button
            type="button"
            className="nav-prefs theme-toggle"
            onClick={onOpenPreferences}
            aria-label="Preferences"
            title="Preferences"
          >
            <Icon name="settings" size={16} />
          </button>
        </div>
        <div className="nav-cluster" id="nav-context-label">Context</div>
        <ContextSelector
          contexts={configStatus.contexts || []}
          contextsInfo={configStatus.contextsInfo}
          currentContext={configStatus.currentContext}
          onChange={onSwitchContext}
          onAddAzure={onAddAzure}
          onAddAws={onAddAws}
          onAddLocal={onAddLocal}
        />
      </div>

      <div className="nav-sections">
        <ul className="nav-list">
          {groups.cluster.map((t) => renderLink(t, { simple: true }))}
        </ul>

        <div className="nav-group-label" aria-hidden="true">Workloads</div>
        {groups.collapsible.map((g) => renderSection(g.key, g.label, g.items.map((t) => renderLink(t))))}

        <div className="nav-group-label" aria-hidden="true">Cluster</div>
        <ul className="nav-list">
          {groups.other.map((t) => renderLink(t, { simple: true }))}
        </ul>

        {argocdInstalled && renderSection('argocd', 'Argo CD', subItems('argocd', ARGO_ITEMS), {
          icon: 'argocd',
          extra: (
            <li key="argocd-settings">
              {renderSection('argocdSettings', 'Settings', subItems('argocd', ARGO_SETTINGS_ITEMS), { nested: true })}
            </li>
          ),
        })}

        {renderSection('security', 'Security Center', subItems('security', SECURITY_ITEMS), { icon: 'shield' })}

        <CustomResourceTree selection={crSelection} onSelect={onSelectCustomResource} />
      </div>
    </nav>
  );
});

export default React.memo(Navigation);
