import { useId, useRef, useState } from 'react';
import Icon from './Icons';
import Modal from './ui/Modal';
import Button from './ui/Button';
import { errorMessage } from '../lib/api';

// Server validation codes → friendly inline messages.
function describeError(err) {
  if (!err) return null;
  const code = err.code;
  if (code === 'invalid_param') return err.field === 'filePath' || !err.field ? 'Enter an absolute path to a kubeconfig file.' : `Invalid ${err.field}.`;
  if (code === 'forbidden') return 'The server is not allowed to read that path.';
  if (code === 'invalid_kubeconfig') return errorMessage(err, 'That file is not a valid kubeconfig.');
  return errorMessage(err, 'Failed to load kubeconfig');
}

/**
 * Connect screen: load a kubeconfig from a path, or import an EKS / AKS
 * cluster straight from the cloud account (`onAddAws` / `onAddAzure`).
 * `onSubmit(path)` resolves to `null` on success or an error (ApiError with
 * `code` / `field`, or a string) shown inline.
 */
export default function KubeConfigModal({ open = true, defaultPath, exists, onSubmit, onAddAws, onAddAzure, onClose }) {
  const id = useId();
  const [path, setPath] = useState(defaultPath || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  const submit = async (e) => {
    e.preventDefault();
    const trimmed = path.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    const err = await onSubmit(trimmed);
    // on success the parent unmounts this modal
    if (err) {
      setError(typeof err === 'string' ? err : describeError(err));
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const inputId = `${id}-path`;
  const errId = `${id}-err`;
  const hintId = `${id}-hint`;
  const canAdd = !!(onAddAws || onAddAzure);

  const where = defaultPath ? ` at ${defaultPath}` : '';
  const description = exists
    ? `A kubeconfig was found${where} but couldn't be loaded. Point KubePilot at a valid kubeconfig file${canAdd ? ', or import an EKS/AKS cluster' : ''}.`
    : `No kubeconfig was found${where}. Point KubePilot at a kubeconfig file${canAdd ? ', or import an EKS/AKS cluster from your cloud account' : ''}.`;

  return (
    <Modal
      open={open}
      onClose={onClose && !busy ? onClose : undefined}
      showClose={!!onClose}
      closeOnBackdrop={!!onClose && !busy}
      closeOnEscape={!!onClose && !busy}
      title="Connect a cluster"
      icon="cluster"
      size="md"
      className="kubeconfig-modal"
      initialFocusRef={inputRef}
      description={description}
    >
      <form onSubmit={submit} noValidate>
        <label htmlFor={inputId} className="ui-modal-label">Kubeconfig file path</label>
        <input
          ref={inputRef}
          id={inputId}
          className="ui-modal-input"
          type="text"
          value={path}
          onChange={(e) => { setPath(e.target.value); if (error) setError(null); }}
          placeholder="/Users/you/.kube/config"
          spellCheck={false}
          autoComplete="off"
          required
          aria-required="true"
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={[error ? errId : null, hintId].filter(Boolean).join(' ')}
          disabled={busy}
        />
        {error && (
          <p id={errId} className="ui-modal-error" role="alert">
            <Icon name="warning" size={13} /> {error}
          </p>
        )}
        <div className="modal-actions">
          <Button type="submit" variant="primary" busy={busy} disabled={!path.trim()}>
            {busy ? 'Loading…' : 'Load kubeconfig'}
          </Button>
        </div>
      </form>

      {canAdd && (
        <div className="modal-add-cluster">
          <div className="modal-or" aria-hidden="true"><span>or add a cluster</span></div>
          <div className="modal-add-cluster-btns" role="group" aria-label="Add cluster">
            {onAddAws && (
              <Button variant="secondary" icon="aws" onClick={() => onAddAws()} disabled={busy} className="btn-add">
                AWS EKS
              </Button>
            )}
            {onAddAzure && (
              <Button variant="secondary" icon="azure" onClick={() => onAddAzure()} disabled={busy} className="btn-add">
                Azure AKS
              </Button>
            )}
          </div>
          <p className="modal-hint modal-hint-tight">
            Import a cluster straight from your cloud account — no CLI required. KubePilot signs you in and writes the kubeconfig for you.
          </p>
        </div>
      )}

      <p id={hintId} className="modal-hint">
        Tip: you can also set the <code>KUBECONFIG</code> environment variable and restart the server.
      </p>
    </Modal>
  );
}
