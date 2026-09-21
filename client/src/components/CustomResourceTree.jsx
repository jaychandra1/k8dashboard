import { afterPaint } from '../lib/a11y';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Icon from './Icons';
import useRequest from '../hooks/useRequest';
import { getJson, p, isAbortError, errorMessage } from '../lib/api';
import { errorTitle } from './shared/errors';

// Lazy sidebar tree: Custom Resources → API group → kind (CRD) → instance.
// A real tree widget: <ul role="tree"> of <li role="treeitem" aria-expanded>
// with roving tabindex; Up/Down move, Right expands / enters, Left collapses /
// goes to the parent, Home/End jump, Enter or Space activates (toggle a
// branch, select a kind or an instance).
//
// selection: { group, version, plural, name?, namespace?, level? } | null
// onSelect(selection)

const ROOT = 'root';
const normalise = (sel) => (sel ? { ...sel, level: sel.level || (sel.name ? 'instance' : 'kind') } : null);

export default function CustomResourceTree({ selection, onSelect, refreshSignal = 0 }) {
  const id = useId();
  const treeRef = useRef(null);
  const sel = normalise(selection);
  const [open, setOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState({});
  const [openKinds, setOpenKinds] = useState({});   // crd.name → bool
  const [instances, setInstances] = useState({});   // crd.name → { loading, items, error }
  const [focusId, setFocusId] = useState(ROOT);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const crdsReq = useRequest(
    ({ signal }) => getJson(p('api', 'customresources'), { signal }),
    { enabled: open, deps: [refreshSignal], dedupeKey: 'crds' },
  );
  const crds = crdsReq.data?.crds;

  const loadInstances = useCallback(async (crd, force = false) => {
    let skip = false;
    setInstances((prev) => {
      const cur = prev[crd.name];
      if (!force && (cur?.items || cur?.loading)) { skip = true; return prev; }
      return { ...prev, [crd.name]: { ...(cur || {}), loading: true, error: null } };
    });
    if (skip) return;
    try {
      const data = await getJson(p('api', 'customresources', crd.group, crd.version, crd.plural));
      if (mounted.current) setInstances((prev) => ({ ...prev, [crd.name]: { loading: false, items: data.items || [], error: null } }));
    } catch (e) {
      if (isAbortError(e) || !mounted.current) return;
      setInstances((prev) => ({ ...prev, [crd.name]: { loading: false, items: prev[crd.name]?.items || [], error: e } }));
    }
  }, []);

  // A global refresh reloads the instance lists that are open.
  const openKindsRef = useRef(openKinds); openKindsRef.current = openKinds;
  const crdsRef = useRef(crds); crdsRef.current = crds;
  useEffect(() => {
    const list = crdsRef.current || [];
    Object.entries(openKindsRef.current).forEach(([name, isOpen]) => {
      const crd = isOpen && list.find((c) => c.name === name);
      if (crd) loadInstances(crd, true);
    });
  }, [refreshSignal, loadInstances]);

  const groups = useMemo(() => {
    if (!crds) return [];
    const map = {};
    crds.forEach((c) => { (map[c.group] = map[c.group] || []).push(c); });
    return Object.keys(map).sort().map((g) => ({ group: g, kinds: map[g].sort((a, b) => (a.kind || '').localeCompare(b.kind || '')) }));
  }, [crds]);

  const toggleRoot = () => setOpen((o) => !o);
  const toggleGroup = (g) => setOpenGroups((prev) => ({ ...prev, [g]: !prev[g] }));
  const toggleKind = (crd) => {
    const willOpen = !openKinds[crd.name];
    setOpenKinds((prev) => ({ ...prev, [crd.name]: willOpen }));
    if (willOpen) loadInstances(crd);
  };

  const isKindSelected = (crd) => !!sel && sel.level === 'kind' && sel.plural === crd.plural && sel.group === crd.group;
  const isInstSelected = (crd, it) => !!sel && sel.level === 'instance' && sel.plural === crd.plural && sel.group === crd.group && sel.name === it.name && sel.namespace === it.namespace;

  // Flat list of the visible items, in DOM order, for keyboard navigation.
  // Cheap enough to rebuild every render (it closes over the toggle helpers).
  const visible = (() => {
    const out = [{ id: ROOT, level: 1, parent: null, expandable: true, expanded: open, toggle: toggleRoot }];
    if (!open) return out;
    groups.forEach(({ group, kinds }) => {
      const gid = `g:${group}`;
      out.push({ id: gid, level: 2, parent: ROOT, expandable: true, expanded: !!openGroups[group], toggle: () => toggleGroup(group) });
      if (!openGroups[group]) return;
      kinds.forEach((crd) => {
        const kid = `k:${crd.name}`;
        out.push({ id: kid, level: 3, parent: gid, expandable: true, expanded: !!openKinds[crd.name], toggle: () => toggleKind(crd), select: () => onSelect?.({ level: 'kind', ...crd }) });
        if (!openKinds[crd.name]) return;
        (instances[crd.name]?.items || []).forEach((it) => {
          out.push({ id: `i:${crd.name}/${it.namespace}/${it.name}`, level: 4, parent: kid, expandable: false, select: () => onSelect?.({ level: 'instance', ...crd, name: it.name, namespace: it.namespace }) });
        });
      });
    });
    return out;
  })();

  const currentFocus = visible.some((v) => v.id === focusId) ? focusId : ROOT;
  const domId = (tid) => `${id}-${tid.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  const focusItem = (tid) => {
    if (!tid) return;
    setFocusId(tid);
    afterPaint(() => {
      const el = Array.from(treeRef.current?.querySelectorAll('[data-tid]') || []).find((n) => n.dataset.tid === tid);
      el?.focus();
    });
  };
  const activate = (item) => { if (item.select) item.select(); else item.toggle(); };
  const onKeyDown = (e, item) => {
    const i = visible.findIndex((v) => v.id === item.id);
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); focusItem(visible[i + 1]?.id); break;
      case 'ArrowUp': e.preventDefault(); focusItem(visible[i - 1]?.id); break;
      case 'Home': e.preventDefault(); focusItem(visible[0].id); break;
      case 'End': e.preventDefault(); focusItem(visible[visible.length - 1].id); break;
      case 'ArrowRight':
        e.preventDefault();
        if (item.expandable && !item.expanded) item.toggle();
        else if (item.expandable && item.expanded) focusItem(visible[i + 1]?.parent === item.id ? visible[i + 1].id : null);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (item.expandable && item.expanded) item.toggle();
        else if (item.parent) focusItem(item.parent);
        break;
      case 'Enter': case ' ': e.preventDefault(); activate(item); break;
      default: return;
    }
    e.stopPropagation();
  };
  // Each treeitem is named by its own label only (not by its nested group).
  const labelId = (item) => `${domId(item.id)}-label`;
  const itemProps = (item, extra = {}) => ({
    role: 'treeitem',
    id: domId(item.id),
    'data-tid': item.id,
    'aria-level': item.level,
    'aria-labelledby': labelId(item),
    'aria-expanded': item.expandable ? item.expanded : undefined,
    tabIndex: item.id === currentFocus ? 0 : -1,
    onFocus: (e) => { if (e.target === e.currentTarget) setFocusId(item.id); },
    onKeyDown: (e) => onKeyDown(e, item),
    onClick: (e) => { e.stopPropagation(); activate(item); },
    ...extra,
  });
  const byId = (tid) => visible.find((v) => v.id === tid);
  const chevron = (item, size = 12) => (
    <span
      className={`nav-section-chevron ${item.expanded ? 'open' : ''}`}
      aria-hidden="true"
      onClick={(e) => { e.stopPropagation(); item.toggle(); }}
    >
      <Icon name="chevronRight" size={size} strokeWidth={2.2} />
    </span>
  );

  const rootItem = byId(ROOT);
  return (
    <ul className="crtree" role="tree" aria-label="Custom resources" ref={treeRef}>
      <li {...itemProps(rootItem, { className: 'crtree-item' })}>
        <div className={`nav-item simple ${open ? 'expanded' : ''}`}>
          {chevron(rootItem, 13)}
          <Icon name="customResources" size={16} className="nav-lead-icon" />
          <span id={labelId(rootItem)}>Custom Resources</span>
        </div>

        {open && (
          <ul role="group" className="crtree-body">
            {!crds && !crdsReq.error && <li className="crtree-msg" role="status">Loading CRDs…</li>}
            {crdsReq.error && !crds && (
              <li className="crtree-msg err" role="alert">
                {errorTitle(crdsReq.error, 'CRDs')}
                <button type="button" className="crtree-retry" onClick={crdsReq.refetch}>Retry</button>
              </li>
            )}
            {crds && groups.length === 0 && <li className="crtree-msg">No custom resource definitions</li>}
            {crds && groups.map(({ group, kinds }) => {
              const gItem = byId(`g:${group}`);
              return (
                <li key={group} {...itemProps(gItem, { className: 'crtree-item crtree-group' })}>
                  <div className="crtree-row lvl1" title={group}>
                    {chevron(gItem)}
                    <span className="crtree-label" id={labelId(gItem)}>{group}<span className="sr-only">, {kinds.length} kinds</span></span>
                    <span className="crtree-count" aria-hidden="true">{kinds.length}</span>
                  </div>

                  {openGroups[group] && (
                    <ul role="group">
                      {kinds.map((crd) => {
                        const kItem = byId(`k:${crd.name}`);
                        const inst = instances[crd.name];
                        const kindSel = isKindSelected(crd);
                        return (
                          <li key={crd.name} {...itemProps(kItem, { className: 'crtree-item crtree-kind', 'aria-selected': kindSel })}>
                            <div className={`crtree-row lvl2 ${kindSel ? 'active' : ''}`} title={crd.kind}>
                              {chevron(kItem)}
                              <span className="crtree-label" id={labelId(kItem)}>{crd.kind}</span>
                            </div>

                            {openKinds[crd.name] && (
                              <ul role="group" className="crtree-instances">
                                {inst?.loading && !inst.items && <li className="crtree-msg lvl3" role="status">Loading…</li>}
                                {inst?.error && (
                                  <li className="crtree-msg lvl3 err" role="alert" title={errorMessage(inst.error)}>
                                    {errorTitle(inst.error, `${crd.kind} instances`)}
                                    <button type="button" className="crtree-retry" onClick={(e) => { e.stopPropagation(); loadInstances(crd, true); }}>Retry</button>
                                  </li>
                                )}
                                {inst && !inst.loading && !inst.error && (inst.items || []).length === 0 && (
                                  <li className="crtree-msg lvl3">no instances</li>
                                )}
                                {(inst?.items || []).map((it) => {
                                  const iItem = byId(`i:${crd.name}/${it.namespace}/${it.name}`);
                                  const active = isInstSelected(crd, it);
                                  return (
                                    <li key={`${it.namespace}/${it.name}`} {...itemProps(iItem, { className: 'crtree-item crtree-leaf', 'aria-selected': active })}>
                                      <div
                                        className={`crtree-row lvl3 leaf ${active ? 'active' : ''}`}
                                        title={`${it.name}${it.namespace && it.namespace !== '-' ? ` (${it.namespace})` : ''}`}
                                      >
                                        <span className="crtree-dot" aria-hidden="true" />
                                        <span className="crtree-label" id={labelId(iItem)}>
                                          {it.name}
                                          {it.namespace && it.namespace !== '-' && <span className="sr-only"> in namespace {it.namespace}</span>}
                                        </span>
                                      </div>
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </li>
    </ul>
  );
}
