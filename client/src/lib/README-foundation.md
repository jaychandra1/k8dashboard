# Client foundation — API + migration notes

Everything below lives under `client/src/{lib,hooks,components/ui}`. Views must
use these instead of local copies (no more per-file `formatAge`, `Donut`,
`KIND_ICON`, `axios.get` + `useEffect`, hand-rolled modals or context menus).

Run `npm test` (vitest) and `npm run build` in `client/` before handing over.

## lib/api.js — the only HTTP/WS entry point

```js
import { api, getJson, postJson, putJson, patchJson, del, p, withQuery, wsUrl, sseFetch,
         ApiError, errorMessage, isAbortError,
         getToken, setToken, clearToken, bootstrapTokenFromHash,
         onUnauthorized, resetUnauthorized } from '../lib/api';
```

| export | signature | notes |
| --- | --- | --- |
| `api` | axios instance (`baseURL: ''`) | adds `Authorization: Bearer <token>` + `X-Requested-With: kubepilot`; rejects with `ApiError` |
| `getJson(url, {signal, params, headers})` | → `Promise<data>` | use inside `useRequest` and pass the `signal` |
| `postJson(url, body, opts)` / `putJson` / `patchJson` | → `Promise<data>` | |
| `del(url, {signal, params, body})` | → `Promise<data>` | |
| `p(...segments)` | → `'/a/b/c'` | **use for every URL**: `p('api','pods',ns,name)` encodes each segment; skips `null`/`''` |
| `withQuery(url, obj)` | → url | skips empty values |
| `wsUrl(path, params)` | → `ws(s)://host/path?…&token=` | for `/ws/exec`, `/ws/agent` |
| `sseFetch(url, body, {signal, method})` | → `Response` | raw `fetch` with auth headers for streaming; throws `ApiError`, fires the 401 hook |
| `ApiError` | `{ status, code, message, body, url, isUnauthorized, isAborted, isNetwork }` | |
| `errorMessage(err, fallback)` | → string | works for ApiError, axios errors, plain errors |
| `onUnauthorized(cb)` | → unsubscribe | fired **once** per session on a 401 (TokenPrompt uses it) |
| `bootstrapTokenFromHash()` | → bool | called in `main.jsx`; reads `#token=` / `#/view?token=` into `sessionStorage['kubepilot.token']` and scrubs the hash |

### Migrate `axios.get` + `useEffect` → `useRequest`

Before:
```js
const [releases, setReleases] = useState([]); const [loading, setLoading] = useState(false); const [error, setError] = useState(null);
useEffect(() => { let live = true; setLoading(true);
  axios.get(`/api/helm/${ns}`).then(r => live && setReleases(r.data)).catch(e => live && setError(e.message)).finally(() => live && setLoading(false));
  return () => { live = false; }; }, [ns]);
```
After:
```js
import useRequest from '../hooks/useRequest';
import { getJson, p } from '../lib/api';
const { data: releases = [], error, loading, refetching, refetch, setData } = useRequest(
  ({ signal }) => getJson(p('api', 'helm', ns), { signal }),
  { deps: [ns], pollMs: 30000, dedupeKey: `helm:${ns}` },
);
```
`useRequest(fn, { deps, enabled, pollMs, keepPreviousData=true, dedupeKey, onSuccess, onError, initialData })`
→ `{ data, error, loading, refetching, updatedAt, refetch, setData }`.
Rules it enforces: abort on deps change/unmount, stale-response guard, poll pause on hidden tab (+ immediate refetch on return), exponential backoff on error (×2, cap 5×pollMs), request dedupe by key.
`useRequestRef(fn)` → stable `(…args) => fn({signal}, …args)` for imperative calls (self-aborting).

Mutations: `await postJson(p('api','pods',ns,name,'scale'), { replicas })` then `refetch()` (or `setData` for optimistic updates). Show failures with `toast.error(errorMessage(err))`.

## lib/format.js

`formatAge(isoOrDate|ms|Date|helmString, now?)` → `12s|5m|3h|2d|3w|4mo|1y|-` ·
`formatAgeSeconds(sec)` · `formatAgeLong(v)` → `5 minutes ago` · `parseHelmDate(str)` → Date|null ·
`fmtCpu(millicores)` → `250m|1.50` · `fmtMem(bytes)` → `35Mi|1.2Gi|512Ki|12B` · `fmtMemMi(mi)` → `512 Mi|1.50 Gi` ·
`parseQuantity('128Mi'|'500m'|'2')` → number (bytes / cores) · `cpuToMillicores(q)` ·
`decodeB64(v)` · `pluralize(n, 'pod', 'pods'?)` · `clamp(n, min, max)` · `fmtInt(n)` · `pct(part, total)`.

## lib/status.js — use `statusTone` / `<Badge>` instead of colour switches

`statusTone(kind?, status)` → `'ok'|'warn'|'bad'|'muted'|'info'` (kind optional: `statusTone('Running')`).
`statusClass(tone)` → `tone-ok` (text colour) · `statusBgClass(tone)` → `bg-tone-ok` (tinted) · `statusToneClass(kind, status)`.
`podPhaseBucket(pod)` → `running|pending|failed|succeeded|unknown` · `BUCKET_TONE`, `BUCKET_LABEL`.

```jsx
<Badge status={pod.status} kind="pod" />            // dot + text, tone derived
<Badge tone="warn">OutOfSync</Badge>
<span className={statusClass(statusTone('argocd', app.health))}>{app.health}</span>
```

## lib/kinds.js — resource registry (replaces PLURAL_KEY / CLUSTER_SCOPED / STANDALONE_RESOURCE_TYPES / nav lists / KIND_ICON copies)

`RESOURCE_TYPES[]` `{ key, label, singular, plural, apiKind, icon, group, clusterScoped, standalone, hidden }` ·
`byKey[key]` · `byApiKind[Kind]` · `KEYS` · `pluralKey(key)` · `isClusterScoped(key)` · `isStandalone(key)` ·
`STANDALONE_KEYS` · `CLUSTER_SCOPED_KEYS` · `labelFor(key)` → `{label, icon, singular}` · `typesInGroup(group)` · `NAV_GROUPS` ·
`KIND_ICON` / `kindIcon(kind)` (merged superset; unknown → `'box'`) · `KIND_TYPE` / `kindType(kind)` (was `lib/kind.js`, still exported there) · `AGENT_ICON`.

Navigation / CommandPalette: build their lists from `typesInGroup('workloads')` etc.

## lib/tokens.js (SVG + xterm colours from CSS tokens)

`cssVar('--green')` · `toneColor('ok')` → hex · `toneTint('ok', .16)` · `trackColor()` · `currentTheme()` → `'light'|'dark'` ·
`xtermTheme()` → xterm ITheme · `onThemeChange(cb)` → unsubscribe. Never hardcode a hex in a view.

## lib/a11y.js

`announce(msg, 'polite'|'assertive')` (persistent live region in index.html) · `srOnly` (= `'sr-only'`) · `FOCUSABLE` selector · `focusables(root)` · `uid(prefix)`.

## lib/hljs.js + `<HighlightedCode>`

`highlight(code, 'yaml'|'json')` → safe HTML (escaped fallback). Only YAML/JSON registered.
`<HighlightedCode code={yaml} lang="yaml" className="yaml-code" trailingNewline />` — the **only** `dangerouslySetInnerHTML` in the app.
Delete `import hljs from 'highlight.js'` and `import 'highlight.js/styles/atom-one-dark.css'` from YamlViewer / Helm / CustomResourceDetail; token colours are themed in App.css (`.hljs-*`).

## hooks

- `useHashRoute()` → `{ route: { view, params[], query{} }, hash, navigate(view, params?, query?, { replace }), back, forward, canBack, canForward, setQuery(patch), isSame(route) }`. Pure helpers `parseHash(hash)`, `buildHash(view, params, query)`; `navigateTo()` for non-React code.
  **App.jsx adoption (App owner):** replace `resourceType` state + the `history` stack with `const { route, navigate, back, forward, canBack, canForward } = useHashRoute()`; `resourceType = route.view`; `setResourceType(k)` → `navigate(k)`; the `ClusterSwitcher` and the Back/Forward buttons (`back`/`canBack`, `.topbar-hist`) are rendered by App and passed to `TopBar` as its `lead` slot (left end of the bar; the switcher fills the column above the sidebar); Navigation has no cluster logic; drawer selection → `navigate(route.view, [ns, name])`; namespace filter → `setQuery({ ns })`; Preferences → `navigate('preferences', [section])` (it's `hidden` in the registry so it stays out of nav). Views that own sub-views (argocd/security) use `route.params[0]`.
- `useDocumentTitle('Pods')` → `Pods · KubePilot`, restored on unmount.
- `useFocusTrap(ref, active, { initialFocusRef?, getInitialFocus?(root), restoreFocus=true })`.
- `useVisibility()` → bool.
- `useRequest`, `useRequestRef` — above.

## components/ui

| component | props |
| --- | --- |
| `Modal` | `{ open, onClose, title, description?, size='sm|md|lg|xl', initialFocusRef?, footer?, danger?, icon?, closeOnBackdrop=true, closeOnEscape=true, showClose=true, className?, ariaLabel? }` — portal into `#modal-root`, `role=dialog aria-modal aria-labelledby aria-describedby`, focus trap + restore, Escape, body scroll lock |
| `ConfirmModal` | `{ open, title, message, confirmLabel, cancelLabel, danger, busy, requireTyped?, icon?, onConfirm, onCancel, children? }` |
| `Button` | `{ variant='primary|secondary|ghost|danger', size='sm|md|lg', icon?, iconOnly?, ariaLabel (required if iconOnly), busy?, ...button }` → `<button type="button" class="ui-btn" data-variant data-size>` |
| `Badge` / `StatusDot` | `{ tone } | { status, kind }`, `dot=true`, `size='sm'?` · `StatusDot { tone, label }` |
| `SearchBox` | `{ value, onChange(str), ariaLabel (required), placeholder, shortcut?, onClear?, autoFocus?, inputProps? }` — labelled `type=search`, clear button, Escape clears |
| `Donut` | `{ segments:[{label,value,tone|color,key?}], size=130, thickness=16, centerLabel?, centerValue?, ariaLabel, legend?, onSegmentClick?(key), activeKey? }` — `<title>`/`<desc>` + sr-only summary |
| `DataTable` | see below |
| `EmptyState` | `{ icon, title, hint, action, size }` |
| `ErrorState` | `{ error, onRetry, title?, retryLabel?, busy?, compact? }` |
| `Skeleton` | `{ rows, cols } | { block, height }` |
| `Tooltip` | `{ content, placement, delay }` wrapping one focusable child; hover+focus, `aria-describedby`, Escape |
| `Menu` | `{ open, x, y, items, onClose(reason), returnFocusTo?, ariaLabel }` items `{ label, icon?, danger?, disabled?, hint?, checked?, onSelect, children?, divider?, heading? }` (`heading: true` = non-interactive group label, skipped by the keyboard); `Menu.open({x,y,items,returnFocusTo})` → `Promise<{close}>`. Full keyboard support + typeahead + submenus; long menus scroll. Legacy `onClick` on items still works |
| `TokenPrompt` | `{ open?, onSuccess, onClose?, autoOpenWhenMissing=true }` — mount once in App; self-opens on missing token or any 401 |
| `ErrorBoundary` | `{ resetKey?, fallback?(err, reset), title?, onError? }` — wrap each routed view with `resetKey={route.view}` |
| `HighlightedCode` | `{ code, lang, className, trailingNewline }` |

### Migrate `<div className="action-modal-backdrop">` → `<Modal>`

Before:
```jsx
{confirm && (
  <div className="action-modal-backdrop" onClick={() => setConfirm(null)}>
    <div className="action-modal" onClick={(e) => e.stopPropagation()}>
      <h3 className="action-modal-title danger"><Icon name="delete" /> Delete pod</h3>
      <p className="action-modal-body">Delete <b>{name}</b>?</p>
      <div className="action-modal-actions">
        <button className="action-modal-btn" onClick={() => setConfirm(null)}>Cancel</button>
        <button className="action-modal-btn primary danger" onClick={doDelete}>Delete</button>
      </div>
    </div>
  </div>
)}
```
After:
```jsx
<ConfirmModal open={!!confirm} title="Delete pod" danger icon="delete" busy={busy}
  message={<>Delete <b>{name}</b>?</>} confirmLabel="Delete"
  onConfirm={doDelete} onCancel={() => setConfirm(null)} />
```
Custom bodies (scale input, sync options): `<Modal open title footer={<><Button…>Cancel</Button><Button variant="primary">Apply</Button></>}>…form…</Modal>` with `.ui-modal-label` / `.ui-modal-input`.

### Migrate a `<table className="resource-table">` → `<DataTable>`

```jsx
<DataTable
  caption={`${label} in ${nsLabel}`}
  columns={[
    { key: 'name', header: 'Name', sortable: true, ellipsis: true, width: 280,
      render: (r) => <span className="resource-name-cell"><Icon name={icon} size={14} className="rn-icon" /><span className="rn-text">{r.name}</span></span> },
    { key: 'namespace', header: 'Namespace', sortable: true, render: (r) => <span className="xlink" onClick={() => nav.toNamespace(r.namespace)}>{r.namespace}</span> },
    { key: 'status', header: 'Status', sortable: true, render: (r) => <Badge status={r.status} kind="pod" /> },
    { key: 'age', header: 'Age', sortable: true, accessor: (r) => Date.parse(r.createdAt), render: (r) => formatAge(r.createdAt), align: 'right', mono: true },
  ]}
  rows={resources} rowKey={(r) => `${r.namespace}/${r.name}`} rowName={(r) => r.name}
  activeKey={selected ? `${selected.namespace}/${selected.name}` : null}
  onRowActivate={onSelectResource}
  rowActions={(r) => [{ label: 'Logs', icon: 'logs', onSelect: () => openLogs(r) }, { divider: true }, { label: 'Delete', icon: 'delete', danger: true, onSelect: () => setConfirm(r) }]}
  selected={selectedKeys} onToggleSelect={(r, key) => toggle(key)} onToggleAll={(checked, rows) => setAll(checked ? rows.map(rowKey) : [])}
  getRowTone={(r) => statusTone('pod', r.status) === 'bad' ? 'bad' : undefined}
  loading={loading} refetching={refetching}
  emptyState={<EmptyState icon="pod" title="No pods" hint="Try another namespace" />}
  initialSort={{ key: 'name', dir: 'asc' }} storageKey="pods"
/>
```
Column: `{ key, header, width?, minWidth?, sortable?, accessor?(row), render?(row, i), compare?(a,b), align?, ellipsis?, maxWidth?, title?(row), mono?, className? }`.
Table props: `rows, rowKey(row,i), rowName(row), onRowActivate(row), onRowContextMenu(row,{x,y}), rowActions(row)→items, selected:Set, onToggleSelect(row,key), onToggleAll(checked, sortedRows), getRowTone(row), activeKey, caption, emptyState, loading, refetching, virtualize (auto >100 rows), rowHeight=42, stickyHeader=true, initialSort, storageKey, dense, maxHeight`.
Keyboard: ↑/↓/Home/End/PageUp/PageDown move (roving tabindex), Enter/Space activate, ContextMenu / Shift+F10 open the row menu. Sort changes are announced.
The wrapper has class `dt-wrap resource-table-wrap` and the table `dt resource-table`, so existing cell classes (`resource-name-cell`, `xlink`, `container-boxes`, …) keep working.

### CSS you can rely on

Tokens: `--focus-ring`, `--amber`, `--blue`, `--bg`, `--bg-code`, `--sidebar-w`, `--z-sticky|dropdown|drawer|modal|toast|palette|tooltip`.
Classes: `.sr-only`, `.skip-link`, `.tone-*`, `.bg-tone-*`, `.status-dot[data-tone]`, `.ui-modal*`, `.ui-btn[data-variant][data-size][data-icon-only]`, `.ui-badge[data-tone]`, `.ui-search*`, `.ui-donut*`, `.dt*` (`.dt-ellipsis`, `.dt-mono`, `.dt-align-right`, `.dt-actions`), `.ui-empty*`, `.ui-error*`, `.ui-skeleton*`, `.ui-tooltip`, `.ui-menu*` (+ legacy `.context-menu*`), `.token-prompt*`, `.hljs-*`, `.nav-toggle`, `.nav-backdrop`, `.app-shell[data-nav="collapsed"|"open"]`.
TopBar owner: render `<button className="nav-toggle" aria-label="Toggle navigation" aria-expanded={navOpen} aria-controls="app-nav">` and toggle `data-nav` on `.app-shell`; add `<div className="nav-backdrop" onClick={close} />` inside `.layout-main`. Give the routed view container `id="main"` (skip-link target).
Typography is now `rem` (root 16px); don't add `px` font sizes; nothing under `0.6875rem` (11px).

## Shell contract (App owner) — what App.jsx passes to views

Routing is `useHashRoute`; App derives everything from the hash and passes it down (no view keeps nav state):

```
#/cluster (default / landing view, also after a context switch)
#/overview?ns=a,b                      #/<resourceKey>[/<ns|->/<name>]?ns=a,b&q=text   (drawer = params)
#/nodes[/<node>]   #/events?ns=a       #/argocd/<sub>   #/security/<sub>   #/preferences/<section>
#/customResources/<group>/<version>/<plural>[/<ns|->/<name>]   #/cluster · #/namespaces · #/topology · #/helm · #/accessControl
```
`ns` absent → all namespaces (`selectedNamespaces = ['all']`); `namespaces` prop is the real list (no sentinel); `q` is owned by ResourceViewer.

Every view gets `refreshSignal: number` (bumps on manual/auto refresh — refetch in place, keep data on screen) and must render one `<h1>`.
`onNavigate` = `{ toNamespace(ns), toNode(name), toResource({type,namespace,name}), toPods(ns, nameFilter) }`.

| view | props |
| --- | --- |
| Overview | `allResources, selectedNamespaces, namespaces, onNamespaceSelect, loading, refetching, partialErrors, onResourceTypeChange, onNavigate, refreshSignal` |
| Cluster | `configStatus, context, refreshSignal, onSummaryLoaded(contextName)` — the shell ends the context-switch LoadingScreen on the first summary for the new context |
| Nodes | `focusNode, onFocusHandled, onNavigate, refreshSignal` |
| Namespaces / AccessControl | `onNavigate, refreshSignal` |
| Topology / Helm | `namespaces, selectedNamespaces, onNavigate, refreshSignal` |
| CustomResourceDetail | `selection {level:'kind'|'instance', group, version, plural, crdName, namespace?, name?}, onSelect(sel), refreshSignal` (CustomResourceTree gets the same `selection`/`onSelect`) |
| SecurityCenter | `namespaces, onNavigate, view (route.params[0]), onViewChange, refreshSignal` |
| ArgoCD | `onNavigate, view (route.params[0]), onViewChange, refreshSignal` |
| Events | `namespace ('all' or the single selected ns), selectedNamespaces, namespaces, onNamespaceChange, onNavigate, refreshSignal` |
| ResourceViewer | `resourceType, resources, allResources, selectedResource, selectedKey {namespace,name}, onSelectResource(res|null), selectedNamespaces, namespaces, onNamespaceChange, loading, refetching, error, partialErrors, totalCount, onResourceTypeChange, onNavigate, onRefresh, refreshSignal, route, navigate, setQuery, context, searchQuery (= route.query.q), onSearchChange` |

`ContextMenu` (`{ x, y, items, onClose }`) is now a wrapper over `ui/Menu`; `NamespaceMultiSelect` keeps `{ namespaces, selected, onChange }`; `Loader` re-exports `Skeleton`. Backend `partial: true` results arrive as `partialErrors: [{ kind, error, namespace? }]` and App already toasts them.
