import { useEffect, useState } from 'react';
import { ConfirmModal } from '../ui/Modal';

/**
 * Delete dialog: <ConfirmModal danger>. A cascading delete (the default) also
 * removes every resource the app manages, so it asks you to type the name.
 * `app` = application | null. onConfirm(app, { cascade }).
 */
export default function DeleteModal({ app, busy, onConfirm, onCancel }) {
  const [cascade, setCascade] = useState(true);
  const open = !!app;
  useEffect(() => { if (open) setCascade(true); }, [open, app?.name]);
  return (
    <ConfirmModal
      open={open}
      danger
      icon="delete"
      title="Delete application"
      busy={busy}
      confirmLabel={busy ? 'Deleting…' : 'Delete'}
      requireTyped={cascade && app ? app.name : undefined}
      message={<>Delete <b>{app?.name}</b>?{cascade ? <> This also deletes <b>all resources it manages</b> and cannot be undone.</> : ' Its managed resources are left in place.'}</>}
      onConfirm={() => onConfirm(app, { cascade })}
      onCancel={onCancel}
    >
      <label className="argo-opt argo-opt-block">
        <input type="checkbox" checked={cascade} onChange={(e) => setCascade(e.target.checked)} />
        <span className="argo-opt-label">Cascade</span>
        <span className="argo-opt-hint">also delete the resources this app manages (uncheck to orphan them)</span>
      </label>
    </ConfirmModal>
  );
}

export { DeleteModal };
