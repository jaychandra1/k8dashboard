import { useEffect, useId, useRef, useState } from 'react';
import Icon from './Icons';
import { useToast } from './Toast';
import HighlightedCode from './ui/HighlightedCode';
import Skeleton from './ui/Skeleton';
import ErrorState from './ui/ErrorState';
import { ConfirmModal } from './ui/Modal';
import useRequest from '../hooks/useRequest';
import { getJson, putJson, p, errorMessage } from '../lib/api';

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');

const applyErrorText = (err) => {
  const msg = errorMessage(err, 'Apply failed');
  switch (err?.code) {
    case 'yaml_mismatch': return `The YAML doesn't match this resource: ${msg}`;
    case 'invalid_yaml': return `Invalid YAML: ${msg}`;
    case 'upstream_error': return `The cluster rejected the change: ${msg}`;
    case 'payload_too_large': return 'The document is too large to apply.';
    case 'forbidden': return `Not allowed: ${msg}`;
    default: return msg;
  }
};

/**
 * Editable YAML editor: fetches the resource, lets the user edit, and applies
 * changes back to the cluster (after confirmation). A transparent textarea
 * sits over a syntax-highlighted <pre> so editing keeps the colours.
 *
 * <YamlViewer namespace kind="deployment" name onClose onApplied />
 */
export default function YamlViewer({ namespace, kind, name, onClose, onApplied, resource, resourceType }) {
  const toast = useToast();
  const uid = useId();
  const k = kind || resourceType;
  const n = name || resource?.name;
  const ns = namespace || resource?.namespace || '';
  const [yaml, setYaml] = useState('');
  const [original, setOriginal] = useState('');
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState(null);
  const [confirm, setConfirm] = useState(null); // 'apply' | 'discard'
  const taRef = useRef(null);
  const preRef = useRef(null);

  const { error: loadError, loading, refetch } = useRequest(
    ({ signal }) => getJson(p('api', 'yaml', ns || '-', k, n), { signal }),
    {
      deps: [ns, k, n],
      enabled: !!k && !!n,
      keepPreviousData: false,
      onSuccess: (d) => { const y = d?.yaml || ''; setYaml(y); setOriginal(y); setApplyError(null); },
    },
  );

  // keep the highlight layer scrolled with the textarea
  const syncScroll = () => {
    if (preRef.current && taRef.current) {
      preRef.current.scrollTop = taRef.current.scrollTop;
      preRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  };

  const dirty = yaml !== original;

  const doApply = async () => {
    if (applying || !dirty) return;
    setApplying(true);
    setApplyError(null);
    try {
      const data = await putJson(p('api', 'yaml', ns || '-', k, n), { yaml });
      toast.success(data?.message || 'Applied', { title: n });
      setOriginal(yaml);
      setConfirm(null);
      onApplied?.({ kind: k, namespace: ns, name: n });
    } catch (err) {
      setApplyError(applyErrorText(err));
      setConfirm(null);
    } finally {
      setApplying(false);
    }
  };
  const requestApply = () => { if (dirty && !applying && !loading) setConfirm('apply'); };
  const requestClose = () => { if (dirty) setConfirm('discard'); else onClose?.(); };

  // Tab inserts two spaces instead of moving focus; ⌘S / Ctrl+S applies.
  const onKeyDown = (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.target; const s = el.selectionStart; const en = el.selectionEnd;
      const next = `${yaml.slice(0, s)}  ${yaml.slice(en)}`;
      setYaml(next);
      requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 2; });
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); requestApply(); }
  };

  // Warn the browser too when leaving the page with unsaved edits.
  useEffect(() => {
    if (!dirty) return undefined;
    const onUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);

  if (!n || !k) return null;
  const shortcut = isMac() ? '⌘S' : 'Ctrl+S';
  const taId = `${uid}-yaml`;
  const hintId = `${uid}-hint`;
  const errId = `${uid}-err`;

  return (
    <div className="yaml-viewer">
      <div className="yaml-toolbar">
        <span className="yaml-title">
          <Icon name="configuration" size={14} /> {n}
          {dirty && <span className="yaml-dirty" role="img" aria-label="Unsaved changes" title="Unsaved changes">●</span>}
        </span>
        <div className="yaml-toolbar-actions">
          <button type="button" className="yaml-btn" onClick={refetch} disabled={loading || applying} aria-label={`Reload YAML of ${n} from the cluster`}>
            <Icon name="refresh" size={13} /> Reload
          </button>
          <button type="button" className="yaml-btn primary" onClick={requestApply} disabled={!dirty || applying || loading} aria-describedby={hintId} aria-busy={applying || undefined}>
            <Icon name="check" size={14} /> {applying ? 'Applying…' : 'Apply'}
          </button>
          {onClose && (
            <button type="button" className="yaml-btn" onClick={requestClose} aria-label={`Close YAML editor for ${n}`}>
              <Icon name="close" size={13} /> Close
            </button>
          )}
        </div>
      </div>
      <span id={hintId} className="sr-only">Press {shortcut} to apply changes to the cluster.</span>
      {applyError && (
        <div className="yaml-error yaml-apply-error" role="alert" id={errId}>
          <Icon name="warning" size={14} /> {applyError}
        </div>
      )}
      <div className="yaml-content">
        {loading ? (
          <div className="yaml-loading"><Skeleton rows={10} cols={2} label="Loading YAML" /></div>
        ) : loadError ? (
          <ErrorState error={loadError} title="Couldn't load YAML" onRetry={refetch} />
        ) : (
          <div className="yaml-edit-wrap">
            <HighlightedCode code={yaml} lang="yaml" className="yaml-code hljs" trailingNewline preProps={{ ref: preRef, 'aria-hidden': true }} />
            <label htmlFor={taId} className="sr-only">YAML for {k} {n}. {shortcut} applies.</label>
            <textarea
              id={taId}
              ref={taRef}
              className="yaml-textarea"
              value={yaml}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              wrap="off"
              onChange={(e) => setYaml(e.target.value)}
              onScroll={syncScroll}
              onKeyDown={onKeyDown}
              aria-describedby={applyError ? `${hintId} ${errId}` : hintId}
              aria-invalid={applyError ? 'true' : undefined}
            />
          </div>
        )}
      </div>

      <ConfirmModal
        open={confirm === 'apply'}
        icon="check"
        title={`Apply changes to ${n}?`}
        message={<>This runs <code>kubectl apply</code> against the cluster for <b>{k}/{n}</b>{ns ? <> in <b>{ns}</b></> : null}.</>}
        confirmLabel="Apply"
        busy={applying}
        onConfirm={doApply}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmModal
        open={confirm === 'discard'}
        danger
        icon="warning"
        title="Discard unsaved changes?"
        message={<>Your edits to <b>{n}</b> haven't been applied. Close anyway?</>}
        confirmLabel="Discard"
        onConfirm={() => { setConfirm(null); setYaml(original); onClose?.(); }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
