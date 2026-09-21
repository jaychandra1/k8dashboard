import { useEffect, useId, useMemo, useState } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import SearchBox from '../ui/SearchBox';
import { statusClass } from '../../lib/status';
import { appKey, syncTone, healthTone } from './status';

const PRESETS = ['all', 'out of sync', 'none'];

/**
 * Multi-select Sync / Refresh dialog over a pool of applications.
 * `request` = { type: 'sync'|'refresh', apps, preselectAll } | null.
 * onConfirm({ type, apps: targets, prune, hard }).
 */
export default function BulkModal({ request, busy, onConfirm, onCancel }) {
  const id = useId();
  const open = !!request;
  const type = request?.type || 'sync';
  const pool = useMemo(() => request?.apps || [], [request]);
  const [sel, setSel] = useState(() => new Set());
  const [filter, setFilter] = useState('');
  const [prune, setPrune] = useState(false);
  const [hard, setHard] = useState(false);

  // Sync starts with nothing selected (deliberate opt-in) unless the caller
  // pre-selected rows; Refresh starts with everything selected.
  useEffect(() => {
    if (!open) return;
    const all = request.preselectAll || request.type === 'refresh';
    setSel(new Set(all ? pool.map(appKey) : []));
    setFilter(''); setPrune(false); setHard(false);
  }, [open, request, pool]);

  const q = filter.trim().toLowerCase();
  const visible = q ? pool.filter((a) => a.name.toLowerCase().includes(q)) : pool;
  const allKeys = pool.map(appKey);
  const outKeys = pool.filter((a) => a.syncStatus !== 'Synced').map(appKey);
  const eq = (arr) => arr.length === sel.size && arr.every((k) => sel.has(k));
  const activePreset = sel.size === 0 ? 'none' : eq(allKeys) ? 'all' : (outKeys.length && eq(outKeys)) ? 'out of sync' : null;
  const applyPreset = (pr) => setSel(new Set(pr === 'all' ? allKeys : pr === 'out of sync' ? outKeys : []));
  const toggle = (k) => setSel((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const n = sel.size;
  const verb = type === 'sync' ? 'Sync' : 'Refresh';

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onCancel}
      title={type === 'sync' ? 'Sync applications' : 'Refresh applications'}
      icon={type === 'sync' ? 'argocd' : 'refresh'}
      size="lg"
      className="argo-bulk-modal"
      closeOnBackdrop={!busy}
      footer={(
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={n === 0} onClick={() => onConfirm({ type, apps: pool.filter((a) => sel.has(appKey(a))), prune, hard })}>
            {busy ? 'Working…' : `${verb} ${n} app${n === 1 ? '' : 's'}`}
          </Button>
        </>
      )}
    >
      <div className="argo-bulk-toolbar">
        <SearchBox value={filter} onChange={setFilter} ariaLabel="Filter applications by name" placeholder="Filter by name…" className="argo-bulk-search" />
        <div className="argo-bulk-presets" role="group" aria-label="Select">
          {PRESETS.map((pr) => (
            <Button key={pr} size="sm" variant="secondary" className="argo-bulk-preset" aria-pressed={activePreset === pr} onClick={() => applyPreset(pr)}>{pr}</Button>
          ))}
        </div>
      </div>

      <ul className="argo-bulk-list" aria-label="Applications">
        {visible.length === 0 ? (
          <li className="argo-bulk-empty">No applications match your filter.</li>
        ) : visible.map((a) => {
          const k = appKey(a);
          return (
            <li key={k}>
              <label className="argo-bulk-row">
                <input type="checkbox" checked={sel.has(k)} onChange={() => toggle(k)} />
                <span className="argo-bulk-name">{a.name}</span>
                <span className={`argo-bulk-sync ${statusClass(syncTone(a.syncStatus))}`}>{a.syncStatus}</span>
                <span className={`argo-bulk-health ${statusClass(healthTone(a.healthStatus))}`}>{a.healthStatus}</span>
              </label>
            </li>
          );
        })}
      </ul>

      <div className="argo-bulk-opts">
        {type === 'sync' ? (
          <label className="argo-bulk-opt">
            <input type="checkbox" checked={prune} onChange={(e) => setPrune(e.target.checked)} />
            Prune resources not in Git
          </label>
        ) : (
          <fieldset className="argo-bulk-radios">
            <legend className="sr-only">Refresh mode</legend>
            <label className="argo-bulk-opt">
              <input type="radio" name={`${id}-mode`} checked={!hard} onChange={() => setHard(false)} /> normal
            </label>
            <label className="argo-bulk-opt">
              <input type="radio" name={`${id}-mode`} checked={hard} onChange={() => setHard(true)} /> hard
            </label>
            <span className="argo-opt-hint">Hard refresh also clears Argo CD's cached manifests.</span>
          </fieldset>
        )}
      </div>
    </Modal>
  );
}

export { BulkModal };
