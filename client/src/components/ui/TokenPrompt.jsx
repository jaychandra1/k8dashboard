import { useEffect, useId, useRef, useState } from 'react';
import Modal from './Modal';
import Button from './Button';
import Icon from '../Icons';
import { getJson, setToken, getToken, clearToken, onUnauthorized, resetUnauthorized, errorMessage } from '../../lib/api';

/**
 * Shown when no token exists at boot or any request returns 401. Verifies the
 * pasted token against GET /api/config/status, stores it, then calls onSuccess.
 *
 *   <TokenPrompt onSuccess={() => refetchEverything()} />
 * Pass `open` to control it manually; otherwise it manages itself.
 */
export default function TokenPrompt({ open: controlledOpen, onSuccess, onClose, autoOpenWhenMissing = true }) {
  const [selfOpen, setSelfOpen] = useState(() => autoOpenWhenMissing && !getToken());
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [reason, setReason] = useState(null); // 'missing' | 'rejected'
  const inputRef = useRef(null);
  const id = useId();
  const open = controlledOpen ?? selfOpen;

  useEffect(() => onUnauthorized(() => {
    setReason('rejected');
    setError(null);
    setSelfOpen(true);
  }), []);

  useEffect(() => { if (open) { setValue(''); setError(null); if (!reason) setReason(getToken() ? 'rejected' : 'missing'); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = async (e) => {
    e?.preventDefault?.();
    const t = value.trim();
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    const prev = getToken();
    setToken(t);
    try {
      await getJson('/api/config/status');
      resetUnauthorized();
      setSelfOpen(false);
      onSuccess?.();
    } catch (err) {
      if (prev) setToken(prev); else clearToken();
      setError(err?.status === 401 ? 'That token was rejected. Check for a copy/paste typo and try again.' : errorMessage(err, 'Could not reach the server.'));
      inputRef.current?.focus();
      inputRef.current?.select();
    } finally {
      setBusy(false);
    }
  };

  const close = () => { setSelfOpen(false); onClose?.(); };

  return (
    <Modal
      open={open}
      onClose={onClose ? close : undefined}
      showClose={!!onClose}
      closeOnBackdrop={false}
      closeOnEscape={!!onClose}
      title={reason === 'rejected' ? 'Session token rejected' : 'Connect to k8dashboard'}
      icon="shield"
      size="sm"
      className="token-prompt"
      initialFocusRef={inputRef}
      footer={(
        <Button variant="primary" type="submit" form={`${id}-form`} busy={busy} disabled={!value.trim()} icon="check">
          Connect
        </Button>
      )}
    >
      <form id={`${id}-form`} onSubmit={connect} className="token-prompt-form">
        <p className="ui-modal-text">
          {reason === 'rejected'
            ? 'The server did not accept the current session token (it may have restarted). Paste the new one to continue.'
            : 'The backend requires a one-time session token. Paste it below to connect.'}
        </p>
        <ul className="token-prompt-hints">
          <li><Icon name="terminal" size={13} /> Printed in the server console when it starts</li>
          <li><Icon name="monitor" size={13} /> The desktop app opens the UI with it automatically</li>
          <li><Icon name="box" size={13} /> Docker: <code>docker logs k8dashboard</code></li>
        </ul>
        <label htmlFor={`${id}-input`} className="ui-modal-label">Session token</label>
        <input
          ref={inputRef}
          id={`${id}-input`}
          className="ui-modal-input token-prompt-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="paste token"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          data-autofocus
        />
        {error && <p id={`${id}-err`} className="ui-modal-error" role="alert"><Icon name="warning" size={13} /> {error}</p>}
      </form>
    </Modal>
  );
}

export { TokenPrompt };
