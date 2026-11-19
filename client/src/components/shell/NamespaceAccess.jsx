import { createContext, useContext, useId, useState } from 'react';
import Button from '../ui/Button';
import { errorMessage } from '../../lib/api';

// How the signed-in user gets at namespaces on the connected cluster.
//
// Most people may list them. Someone who was given a Role in one namespace
// (and nothing cluster-wide) may not, and Kubernetes has no way to ask "which
// namespaces are mine?". For them `restricted` is true and the list is the
// namespaces they added by name — checked against the cluster and remembered
// for that cluster — plus the one their kubeconfig context names.
//
//   const { restricted, namespaces, add, remove } = useNamespaceAccess();
//   add(name) / remove(name) → Promise; add rejects with the reason (no access,
//   not a namespace name).
const NamespaceAccessContext = createContext({ restricted: false, namespaces: [], add: null, remove: null });

export const NamespaceAccessProvider = NamespaceAccessContext.Provider;
export const useNamespaceAccess = () => useContext(NamespaceAccessContext);

/** Said wherever a restricted user is asked for a namespace. */
export const RESTRICTED_HINT = 'This sign-in can’t list the cluster’s namespaces. Add the ones you were given access to.';

/**
 * "Namespace name [Add]" — adds it for this cluster (the server checks that
 * the user has access there) and reports it: onAdded(name).
 */
export function AddNamespaceForm({ onAdded, autoFocus = false, compact = false }) {
  const { add } = useNamespaceAccess();
  const id = useId();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const value = name.trim().toLowerCase();
    if (!value || busy || !add) return;
    setBusy(true);
    setError('');
    try {
      await add(value);
      setName('');
      onAdded?.(value);
    } catch (err) {
      setError(errorMessage(err, 'The namespace could not be added.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="ns-add" data-compact={compact || undefined} onSubmit={submit} noValidate>
      <div className="ns-add-row">
        <label className="sr-only" htmlFor={`${id}-name`}>Namespace name</label>
        <input
          id={`${id}-name`}
          className="ns-add-input"
          type="text"
          value={name}
          onChange={(e) => { setName(e.target.value); if (error) setError(''); }}
          placeholder="Namespace name"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={63}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          autoFocus={autoFocus}
        />
        <Button type="submit" variant="primary" size="sm" busy={busy} disabled={!name.trim()}>Add</Button>
      </div>
      {error && <p id={`${id}-err`} className="ns-add-error" role="alert">{error}</p>}
    </form>
  );
}
