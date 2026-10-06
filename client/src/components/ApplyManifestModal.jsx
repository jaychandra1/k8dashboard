import { useId, useRef, useState } from 'react';
import Icon from './Icons';
import Modal, { ConfirmModal } from './ui/Modal';
import Button from './ui/Button';
import HighlightedCode from './ui/HighlightedCode';
import { postJson, errorMessage } from '../lib/api';

// Create (or update) resources from manifests — the in-app `kubectl apply -f`.
// Paste YAML, open or drop .yaml/.yml/.json files, or start from an example;
// "Validate" runs a server-side dry run (nothing is changed), "Apply" applies
// every document in order after a confirmation, and each document's outcome is
// listed. Backend: POST /api/apply { yaml, dryRun, namespace }.
//
//   <ApplyManifestModal open onClose namespaces defaultNamespace context onApplied />

export const MAX_MANIFEST_BYTES = 3 * 1024 * 1024; // matches the server's limit

export const EXAMPLES = {
  Deployment: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  labels:
    app: my-app
spec:
  replicas: 1
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: my-app
          image: nginx:1.27
          ports:
            - containerPort: 80
`,
  Service: `apiVersion: v1
kind: Service
metadata:
  name: my-app
spec:
  selector:
    app: my-app
  ports:
    - port: 80
      targetPort: 80
`,
  ConfigMap: `apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
data:
  KEY: value
`,
  Namespace: `apiVersion: v1
kind: Namespace
metadata:
  name: my-namespace
`,
};

// Documents in a multi-document YAML stream (separator lines `---`), ignoring
// empty or comment-only documents. Only for the count shown in the UI; the
// server parses for real.
export function countDocuments(text) {
  return String(text || '')
    .split(/^---[ \t]*(?:#.*)?$/m)
    .filter((part) => part.split('\n').some((line) => line.trim() && !line.trim().startsWith('#')))
    .length;
}

const join = (current, next) => (current.trim() ? `${current.replace(/\s+$/, '')}\n---\n${next}` : next);

const readText = (file) => (typeof file.text === 'function'
  ? file.text()
  : new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  }));

export default function ApplyManifestModal({ open, onClose, namespaces = [], defaultNamespace = '', context, onApplied }) {
  const uid = useId();
  const [text, setText] = useState('');
  const [namespace, setNamespace] = useState(defaultNamespace || '');
  const [busy, setBusy] = useState(null); // 'validate' | 'apply' | null
  const [outcome, setOutcome] = useState(null); // { dryRun, ok, error?, results? }
  const [confirm, setConfirm] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef(null);
  const taRef = useRef(null);

  const docs = countDocuments(text);
  const tooLarge = new Blob([text]).size > MAX_MANIFEST_BYTES;
  const canSubmit = docs > 0 && !tooLarge && !busy;
  const applied = outcome && !outcome.dryRun && outcome.ok;

  const edit = (next) => { setText(next); setOutcome(null); };

  const addFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    let next = text;
    for (const f of files) {
      const content = await readText(f);
      next = join(next, `# File: ${f.name}\n${content.replace(/^\uFEFF/, '')}`);
    }
    edit(next);
  };

  const insertExample = (kind) => {
    if (!EXAMPLES[kind]) return;
    edit(join(text, EXAMPLES[kind]));
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const submit = async (dryRun) => {
    setConfirm(false);
    setBusy(dryRun ? 'validate' : 'apply');
    setOutcome(null);
    try {
      const data = await postJson('/api/apply', { yaml: text, dryRun, namespace: namespace || undefined });
      setOutcome({ dryRun, ok: true, results: data.results || [] });
      if (!dryRun) onApplied?.(data);
    } catch (err) {
      const results = Array.isArray(err?.body?.results) ? err.body.results : null;
      setOutcome({ dryRun, ok: false, error: errorMessage(err, dryRun ? 'Validation failed' : 'Apply failed'), results });
      // Some documents may have been applied even though others failed.
      if (!dryRun && results?.some((r) => r.ok)) onApplied?.(err.body);
    } finally {
      setBusy(null);
    }
  };

  // Tab inserts two spaces instead of moving focus.
  const onKeyDown = (e) => {
    if (e.key !== 'Tab' || e.shiftKey) return;
    e.preventDefault();
    const el = e.currentTarget; const s = el.selectionStart; const en = el.selectionEnd;
    edit(`${text.slice(0, s)}  ${text.slice(en)}`);
    requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 2; });
  };
  const pinTextarea = (e) => { const t = e.currentTarget; if (t.scrollTop || t.scrollLeft) { t.scrollTop = 0; t.scrollLeft = 0; } };

  const okCount = outcome?.results?.filter((r) => r.ok).length || 0;
  const failCount = outcome?.results ? outcome.results.length - okCount : 0;
  let summary = null;
  if (outcome) {
    if (outcome.dryRun && outcome.ok) summary = `Dry run passed for ${okCount} ${okCount === 1 ? 'resource' : 'resources'} — nothing was changed.`;
    else if (outcome.ok) summary = `Applied ${okCount} ${okCount === 1 ? 'resource' : 'resources'}.`;
    else if (outcome.results) summary = outcome.dryRun ? `Dry run: ${failCount} of ${outcome.results.length} would fail — nothing was changed.` : `${okCount} applied, ${failCount} failed.`;
  }

  const taId = `${uid}-yaml`;
  const nsId = `${uid}-ns`;
  const exId = `${uid}-example`;
  const where = typeof context === 'string' && context ? context : 'the current cluster';

  return (
    <>
      <Modal
        open={open}
        onClose={busy ? undefined : onClose}
        title="Apply manifests"
        description="Create or update resources from YAML — the same as kubectl apply. Paste manifests, open files, or start from an example."
        icon="plus"
        size="xl"
        className="apply-modal"
        closeOnBackdrop={false}
        footer={(
          <>
            <span className="apply-docs" aria-live="polite">
              {tooLarge ? 'Too large (3 MB max)' : `${docs} ${docs === 1 ? 'document' : 'documents'}`}
            </span>
            <Button variant="secondary" onClick={onClose} disabled={!!busy}>{applied ? 'Close' : 'Cancel'}</Button>
            <Button variant="secondary" icon="check" onClick={() => submit(true)} disabled={!canSubmit} busy={busy === 'validate'}>Validate (dry run)</Button>
            <Button variant="primary" icon="upload" onClick={() => setConfirm(true)} disabled={!canSubmit} busy={busy === 'apply'}>Apply</Button>
          </>
        )}
      >
        <div className="apply-toolbar">
          <input
            ref={fileRef}
            type="file"
            accept=".yaml,.yml,.json,application/x-yaml,text/yaml,application/json"
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
          />
          <Button size="sm" icon="upload" onClick={() => fileRef.current?.click()}>Open files…</Button>
          <label htmlFor={exId} className="sr-only">Insert an example manifest</label>
          <select id={exId} className="apply-select" value="" onChange={(e) => insertExample(e.target.value)}>
            <option value="">Insert example…</option>
            {Object.keys(EXAMPLES).map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <span className="apply-spacer" />
          <label htmlFor={nsId} className="apply-ns-label">Namespace for manifests without one</label>
          <select id={nsId} className="apply-select" value={namespace} onChange={(e) => setNamespace(e.target.value)}>
            <option value="">Context default</option>
            {namespaces.filter((n) => n && n !== 'all').map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>

        <div
          className={`apply-editor${dragging ? ' dragging' : ''}`}
          onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDragging(true); } }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); } }}
        >
          <div className="yaml-edit-scroll">
            <div className="yaml-edit-stack">
              <HighlightedCode code={text} lang="yaml" className="yaml-code hljs" trailingNewline preProps={{ 'aria-hidden': true }} />
              <label htmlFor={taId} className="sr-only">Manifests (YAML). Separate documents with ---.</label>
              <textarea
                id={taId}
                ref={taRef}
                className="yaml-textarea"
                value={text}
                placeholder={'Paste one or more manifests, separated by ---\nor drop .yaml files here'}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                wrap="off"
                onChange={(e) => edit(e.target.value)}
                onScroll={pinTextarea}
                onKeyDown={onKeyDown}
              />
            </div>
          </div>
          {dragging && <div className="apply-drop" aria-hidden="true"><Icon name="upload" size={20} /> Drop files to add them</div>}
        </div>

        {outcome && (
          <div className={`apply-outcome ${outcome.ok ? 'ok' : 'bad'}`} role={outcome.ok ? 'status' : 'alert'}>
            <div className="apply-outcome-head">
              <Icon name={outcome.ok ? 'check' : 'warning'} size={14} strokeWidth={outcome.ok ? 2.6 : 2} />
              <span>{summary || outcome.error}</span>
            </div>
            {outcome.results?.length > 0 && (
              <ul className="apply-results">
                {outcome.results.map((r, i) => (
                  <li key={`${i}:${r.label}`} className={r.ok ? 'ok' : 'bad'}>
                    <Icon name={r.ok ? 'check' : 'close'} size={12} strokeWidth={2.6} />
                    <span className="apply-res-name">{r.label}</span>
                    {r.namespace && <span className="apply-res-ns">{r.namespace}</span>}
                    {!r.ok && <span className="apply-res-err">{r.error}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={confirm}
        icon="upload"
        title={`Apply ${docs} ${docs === 1 ? 'manifest' : 'manifests'}?`}
        message={<>This creates or updates {docs === 1 ? 'the resource' : `${docs} resources`} on <b>{where}</b>{namespace ? <>, using namespace <b>{namespace}</b> where a manifest names none</> : null}.</>}
        confirmLabel="Apply"
        busy={busy === 'apply'}
        onConfirm={() => submit(false)}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
}
