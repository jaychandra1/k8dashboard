import { useEffect, useId, useState } from 'react';
import { ConfirmModal } from './ui/Modal';
import { postJson, errorMessage } from '../lib/api';
import { redactSensitive } from '../lib/redact';

// Confirmation for removing a cluster (a kubeconfig context): asks the server
// what would go (POST /api/config/contexts/remove { dryRun: true }) and shows
// exactly that, then removes it on confirm. Removing is not signing out: the
// cluster leaves the kubeconfig file, for kubectl too; a backup is kept.
// Entry and profile names can embed account ids (ARNs, "sso-<id>"): masked.
//   <RemoveClusterDialog context="dev" onClose={…} onRemoved={(result) => …} />

const listOf = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
const show = (s) => redactSensitive(String(s ?? ''));

function EntryLine({ entry, what }) {
  if (!entry) return null;
  return entry.removed
    ? <li>Its {what} entry <strong>{show(entry.name)}</strong></li>
    : <li className="rmc-kept">Kept: its {what} entry <strong>{show(entry.name)}</strong>, used by {listOf(entry.usedBy.map(show))}</li>;
}

export default function RemoveClusterDialog({ context, onClose, onRemoved }) {
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [withProfile, setWithProfile] = useState(false);
  const checkId = useId();

  useEffect(() => {
    if (!context) return undefined;
    let live = true;
    setPlan(null);
    setError(null);
    setWithProfile(false);
    postJson('/api/config/contexts/remove', { context, dryRun: true })
      .then((p) => { if (live) setPlan(p); })
      .catch((e) => { if (live) setError(errorMessage(e, 'The kubeconfig could not be read.')); });
    return () => { live = false; };
  }, [context]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await postJson('/api/config/contexts/remove', { context, removeAwsProfile: withProfile });
      onRemoved?.(out);
    } catch (e) {
      setError(errorMessage(e, 'The cluster could not be removed.'));
    } finally {
      setBusy(false);
    }
  };

  const profile = plan?.awsProfile;
  return (
    <ConfirmModal
      open={!!context}
      title={`Remove ${show(context)}?`}
      danger
      icon="delete"
      confirmLabel="Remove cluster"
      busy={busy}
      confirmDisabled={!plan}
      onConfirm={confirm}
      onCancel={onClose}
    >
      {!plan && !error && <p className="ui-modal-text">Checking what would be removed…</p>}
      {plan && (
        <div className="rmc">
          <p className="ui-modal-text">
            It is removed from your kubeconfig (<code>{show(plan.file)}</code>), so kubectl and other tools that read
            that file won't see it either. A backup of the file is saved first.
          </p>
          <ul className="rmc-list" aria-label="What is removed">
            <li>The cluster <strong>{show(plan.context)}</strong></li>
            <EntryLine entry={plan.user} what="credentials" />
            <EntryLine entry={plan.cluster} what="server" />
          </ul>
          {plan.current && plan.switchTo && <p className="rmc-note">You're using this cluster: K8Board switches to <strong>{show(plan.switchTo)}</strong>.</p>}
          {plan.lastCluster && <p className="rmc-note">It is your last cluster: you'll be asked to add a cluster or open another kubeconfig.</p>}
          {profile?.removable && (
            <label className="rmc-check" htmlFor={checkId}>
              <input id={checkId} type="checkbox" checked={withProfile} onChange={(e) => setWithProfile(e.target.checked)} disabled={busy} />
              <span>
                Also remove its AWS profile <strong>{show(profile.name)}</strong> from ~/.aws/config
                <span className="rmc-hint">Leave it if you use this profile with the AWS CLI.</span>
              </span>
            </label>
          )}
          {profile && !profile.removable && (
            <p className="rmc-hint">Its AWS profile <strong>{show(profile.name)}</strong> stays: {listOf(profile.usedBy.map(show))} {profile.usedBy.length === 1 ? 'uses' : 'use'} it too.</p>
          )}
        </div>
      )}
      {error && <p className="rmc-error" role="alert">{show(error)}</p>}
    </ConfirmModal>
  );
}
