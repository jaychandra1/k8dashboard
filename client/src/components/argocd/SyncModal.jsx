import { useEffect, useState } from 'react';
import { ConfirmModal } from '../ui/Modal';

const OPTIONS = [
  ['prune', 'Prune', 'Delete resources no longer in Git'],
  ['dryRun', 'Dry run', 'Preview only, apply nothing'],
  ['applyOnly', 'Apply only', 'Skip sync hooks'],
  ['force', 'Force', 'kubectl apply --force'],
  ['replace', 'Replace', 'Use replace instead of apply'],
];
const DEFAULTS = { prune: false, dryRun: false, applyOnly: false, force: false, replace: false };

/**
 * Sync dialog: <ConfirmModal> with the sync options as its body.
 * `request` = { app, revision? } | null. onConfirm(app, options).
 */
export default function SyncModal({ request, busy, onConfirm, onCancel }) {
  const [opts, setOpts] = useState(DEFAULTS);
  const open = !!request;
  useEffect(() => { if (open) setOpts(DEFAULTS); }, [open, request?.app?.name, request?.revision]);
  const app = request?.app;
  const revision = request?.revision;
  return (
    <ConfirmModal
      open={open}
      title={app ? `Sync ${app.name}` : 'Sync'}
      icon="argocd"
      busy={busy}
      confirmLabel={busy ? 'Syncing…' : 'Synchronize'}
      message={revision
        ? <>Apply revision <b>{revision}</b> of the Git state to <b>{app?.name}</b>.</>
        : <>Apply the target Git state to <b>{app?.name}</b>.</>}
      onConfirm={() => onConfirm(app, { ...opts, revision })}
      onCancel={onCancel}
    >
      <fieldset className="argo-sync-opts">
        <legend className="sr-only">Sync options</legend>
        {OPTIONS.map(([k, label, hint]) => (
          <label key={k} className="argo-opt">
            <input type="checkbox" checked={!!opts[k]} onChange={(e) => setOpts((o) => ({ ...o, [k]: e.target.checked }))} />
            <span className="argo-opt-label">{label}</span>
            <span className="argo-opt-hint">{hint}</span>
          </label>
        ))}
      </fieldset>
    </ConfirmModal>
  );
}

export { SyncModal };
