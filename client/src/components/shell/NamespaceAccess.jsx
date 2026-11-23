import { createContext, useContext, useId, useState } from 'react';
import Button from '../ui/Button';
import { useOptionalToast } from '../Toast';
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
 * What was typed → the names in it: "qaenv, stage  Team-B" → ['qaenv', 'stage',
 * 'team-b']. Commas, semicolons or spaces between them; each name once.
 */
export function parseNamespaceNames(text) {
  return Array.from(new Set(String(text ?? '').toLowerCase().split(/[\s,;]+/).filter(Boolean)));
}

// Why one name out of several was not added, in a word or two (the full
// sentence is for a single name).
const WHY = { no_access: 'no access', invalid_param: 'not a namespace name' };
const why = (err) => WHY[err?.code] || errorMessage(err, 'could not be added');

/**
 * "Namespace name [Add]" — adds a namespace for this cluster, or several typed
 * with commas between them. Each one is added on its own (the server checks
 * that the user has access there), so one wrong name doesn't stop the others.
 *
 *   onAdded(names) — everything typed was added.
 *
 * When some were refused, the ones added are added all the same (they are in
 * every namespace picker from then on); the form says which were and which
 * were not, and keeps the refused names in the field to be corrected.
 *
 * `leavesWhenAdded`: the form's place goes away as soon as a namespace is
 * added (an empty list that asked for one then has rows). What was refused
 * is then said in a notice, which stays, instead of in the form.
 */
export function AddNamespaceForm({ onAdded, autoFocus = false, compact = false, leavesWhenAdded = false }) {
  const { add } = useNamespaceAccess();
  const toast = useOptionalToast();
  const id = useId();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const names = parseNamespaceNames(text);
    if (!names.length || busy || !add) return;
    setBusy(true);
    setError('');
    setNote('');
    const added = [];
    const refused = [];
    for (const name of names) {
      try {
        await add(name);
        added.push(name);
      } catch (err) {
        refused.push({ name, err });
      }
    }
    if (refused.length) {
      const message = names.length === 1
        ? errorMessage(refused[0].err, 'The namespace could not be added.')
        : `Not added: ${refused.map((r) => `${r.name} (${why(r.err)})`).join(', ')}. Check the names, or ask your cluster administrator.`;
      const addedNote = added.length ? `Added ${added.join(', ')}.` : '';
      setBusy(false);
      if (leavesWhenAdded && added.length) {
        toast?.warning(`${addedNote} ${message}`, { title: 'Namespaces' });
      } else {
        setText(refused.map((r) => r.name).join(', '));
        setError(message);
        setNote(addedNote);
      }
      return;
    }
    setText('');
    setBusy(false);
    onAdded?.(added);
  };

  return (
    <form className="ns-add" data-compact={compact || undefined} onSubmit={submit} noValidate>
      <div className="ns-add-row">
        <label className="sr-only" htmlFor={`${id}-name`}>Namespace name</label>
        <input
          id={`${id}-name`}
          className="ns-add-input"
          type="text"
          value={text}
          onChange={(e) => { setText(e.target.value); if (error) setError(''); if (note) setNote(''); }}
          placeholder="Name, or several with commas"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={640}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          autoFocus={autoFocus}
        />
        <Button type="submit" variant="primary" size="sm" busy={busy} disabled={!text.trim()}>Add</Button>
      </div>
      {note && <p className="ns-add-note" role="status">{note}</p>}
      {error && <p id={`${id}-err`} className="ns-add-error" role="alert">{error}</p>}
    </form>
  );
}
