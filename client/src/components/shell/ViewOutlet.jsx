import ResourceViewer from '../ResourceViewer';
import Overview from '../Overview';
import Cluster from '../Cluster';
import Nodes from '../Nodes';
import Namespaces from '../Namespaces';
import Topology from '../Topology';
import Helm from '../Helm';
import CustomResourceDetail from '../CustomResourceDetail';
import AccessControl from '../AccessControl';
import SecurityCenter from '../SecurityCenter';
import ArgoCD from '../ArgoCD';
import Events from '../Events';
import Preferences from '../Preferences';
import EmptyState from '../ui/EmptyState';
import { ALL } from './routes';

/**
 * Routes `route.view` to a view component. This is THE prop contract between
 * the shell (App) and the views; every view receives `refreshSignal` (number,
 * bumps on manual/auto refresh — refetch in place, keep data on screen).
 *
 *   Overview            { allResources, selectedNamespaces, namespaces, onNamespaceSelect, loading, refetching, partialErrors, onResourceTypeChange, onNavigate, refreshSignal }
 *   Cluster             { configStatus, context, refreshSignal }
 *   Nodes               { focusNode, onFocusHandled, onNavigate, refreshSignal }
 *   Namespaces          { onNavigate, refreshSignal }
 *   Topology            { namespaces, selectedNamespaces, onNavigate, refreshSignal }
 *   Helm                { namespaces, selectedNamespaces, onNavigate, refreshSignal }
 *   CustomResourceDetail{ selection, onSelect, refreshSignal }
 *   AccessControl       { onNavigate, refreshSignal }
 *   SecurityCenter      { namespaces, onNavigate, view, onViewChange, refreshSignal }
 *   ArgoCD              { onNavigate, view, onViewChange, refreshSignal }
 *   Events              { namespace, selectedNamespaces, namespaces, onNamespaceChange, onNavigate, refreshSignal }
 *   Preferences         { configStatus, theme, onSetTheme, onChangeConfig, onAddAzure, onAddAws, section, onSectionChange, onClose }
 *   ResourceViewer      { resourceType, resources, allResources, selectedResource, selectedKey, onSelectResource, selectedNamespaces, namespaces,
 *                         onNamespaceChange, loading, refetching, error, partialErrors, totalCount, onResourceTypeChange, onNavigate, onRefresh,
 *                         refreshSignal, route, navigate, setQuery, context, searchQuery, onSearchChange }
 *
 * `selectedNamespaces` is `['all']` or a list of names; `namespaces` is the real
 * list (no sentinel). `onNavigate` is the cross-link object
 * { toNamespace(ns), toNode(name), toResource({type,namespace,name}), toPods(ns, nameFilter) }.
 */
export default function ViewOutlet({
  view, route, navigate, setQuery,
  refreshSignal, onRefresh,
  configStatus, theme, onSetTheme,
  namespaces, selectedNamespaces, onNamespaceChange,
  allResources, resources, loading, refetching, error, partialErrors,
  selectedResource, selectedKey, onSelectResource,
  focusNode, onFocusHandled,
  crSelection, onSelectCustomResource,
  subView, onSubViewChange,
  prefSection, onPrefSectionChange, onClosePreferences, onChangeConfig, onAddAzure, onAddAws,
  onResourceTypeChange, nav,
}) {
  const single = selectedNamespaces.length === 1 && selectedNamespaces[0] !== ALL ? selectedNamespaces[0] : ALL;

  switch (view) {
    case 'overview':
      return (
        <Overview
          allResources={allResources}
          selectedNamespaces={selectedNamespaces}
          namespaces={namespaces}
          onNamespaceSelect={onNamespaceChange}
          loading={loading}
          refetching={refetching}
          partialErrors={partialErrors}
          onResourceTypeChange={onResourceTypeChange}
          onNavigate={nav}
          refreshSignal={refreshSignal}
        />
      );
    case 'cluster':
      return <Cluster configStatus={configStatus} context={configStatus.currentContext} refreshSignal={refreshSignal} />;
    case 'nodes':
      return <Nodes focusNode={focusNode} onFocusHandled={onFocusHandled} onNavigate={nav} refreshSignal={refreshSignal} />;
    case 'namespaces':
      return <Namespaces onNavigate={nav} refreshSignal={refreshSignal} />;
    case 'topology':
      return <Topology namespaces={namespaces} selectedNamespaces={selectedNamespaces} onNavigate={nav} refreshSignal={refreshSignal} />;
    case 'helm':
      return <Helm namespaces={namespaces} selectedNamespaces={selectedNamespaces} onNavigate={nav} refreshSignal={refreshSignal} />;
    case 'customResources':
      return <CustomResourceDetail selection={crSelection} onSelect={onSelectCustomResource} refreshSignal={refreshSignal} />;
    case 'accessControl':
      return <AccessControl onNavigate={nav} refreshSignal={refreshSignal} />;
    case 'security':
      return <SecurityCenter namespaces={namespaces} onNavigate={nav} view={subView} onViewChange={onSubViewChange} refreshSignal={refreshSignal} />;
    case 'argocd':
      return <ArgoCD onNavigate={nav} view={subView} onViewChange={onSubViewChange} refreshSignal={refreshSignal} />;
    case 'events':
      return (
        <Events
          namespace={single}
          selectedNamespaces={selectedNamespaces}
          namespaces={namespaces}
          onNamespaceChange={onNamespaceChange}
          onNavigate={nav}
          refreshSignal={refreshSignal}
        />
      );
    case 'preferences':
      return (
        <Preferences
          configStatus={configStatus}
          theme={theme}
          onSetTheme={onSetTheme}
          onChangeConfig={onChangeConfig}
          onAddAzure={onAddAzure}
          onAddAws={onAddAws}
          section={prefSection}
          onSectionChange={onPrefSectionChange}
          onClose={onClosePreferences}
        />
      );
    default:
      if (!resources) {
        return <EmptyState icon="box" title="Unknown view" hint={`There is no view called "${view}".`} />;
      }
      return (
        <ResourceViewer
          resourceType={view}
          resources={resources}
          allResources={allResources}
          selectedResource={selectedResource}
          selectedKey={selectedKey}
          onSelectResource={onSelectResource}
          selectedNamespaces={selectedNamespaces}
          namespaces={namespaces}
          onNamespaceChange={onNamespaceChange}
          loading={loading}
          refetching={refetching}
          error={error}
          partialErrors={partialErrors}
          totalCount={resources.length}
          onResourceTypeChange={onResourceTypeChange}
          onNavigate={nav}
          onRefresh={onRefresh}
          refreshSignal={refreshSignal}
          route={route}
          navigate={navigate}
          setQuery={setQuery}
          context={configStatus.currentContext}
          searchQuery={route.query.q || ''}
          onSearchChange={(q) => setQuery({ q: q || undefined })}
        />
      );
  }
}
