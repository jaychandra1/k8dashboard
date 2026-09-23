import { useRef, useState } from 'react';
import Icon from './Icons';
import ContextSelector from './ContextSelector';
import Modal from './ui/Modal';
import Button from './ui/Button';
import Menu from './ui/Menu';

// Blocking dialog shown before the app loads when the kubeconfig parses but the
// cluster credentials don't actually work (expired token, unreachable API
// server, untrusted TLS, missing exec auth plugin, …).
//
// Cloud providers return enormous, jargon-heavy error strings. Rather than dump
// that on the user, we classify the common cases into a one-line summary + a
// concrete, often one-click fix, and tuck the raw error behind a disclosure.

const TITLES = {
  'no-config': 'No kubeconfig loaded',
  unauthorized: 'Cluster authentication failed',
  unreachable: 'Cluster unreachable',
  tls: 'TLS certificate error',
  'exec-plugin': 'Auth plugin failed',
  error: 'Could not connect to the cluster',
};

// Pull a runnable re-login command out of a provider error string when present.
const extractAzLogin = (raw) => (raw.match(/az login\b[^\n]*?--scope\s+"[^"]*"/i) || raw.match(/az login\b[^\n."]*/i) || [])[0]?.trim() || null;
const extractAwsSso = (raw) => (raw.match(/aws sso login(?:\s+--profile\s+\S+)?/i) || [])[0]?.trim() || null;

// Classify the failure into { title, summary, fix } where fix describes the
// remediation (a one-click cloud sign-in and/or a copyable CLI command).
export function classify(auth) {
  const reason = auth?.reason || 'error';
  const raw = auth?.message || '';
  const s = raw.toLowerCase();
  const server = (auth?.server || '').toLowerCase();
  const provider = /azmk8s\.io|\.azure/.test(server) ? 'azure'
    : /eks\.amazonaws|\.eks\./.test(server) ? 'aws'
      : /gke|container\.googleapis/.test(server) ? 'gcp' : null;

  // Server-side classifications of the bundled token helpers come first: the
  // backend has already looked at the exec plugin's stderr / exit status.
  if (reason === 'sso-expired') {
    return {
      title: 'AWS SSO session expired',
      summary: 'Your AWS SSO session has expired, so the cluster token could not be refreshed. Sign in again to refresh it, then retry.',
      fix: { kind: 'aws', label: 'Sign in with AWS SSO', command: extractAwsSso(auth?.detail || raw) || 'aws sso login' },
    };
  }
  if (reason === 'exec-helper') {
    return {
      title: 'Cluster auth helper failed',
      summary: raw || "KubePilot's kubeconfig auth helper for this cluster could not produce a token.",
      fix: { kind: 'note', note: 'Stale helper entries are repaired automatically — click Retry. If it keeps failing, re-import the cluster from Add cluster.' },
    };
  }

  if (/aadsts|azureclicredential|az login\b/.test(s) || (provider === 'azure' && /token|expired|credential|refresh/.test(s))) {
    const cli = /azurecli|kubelogin/.test(s);
    return {
      title: 'Azure sign-in expired',
      summary: 'Your Azure sign-in has expired, so the cluster token could not be refreshed. Sign in to Azure again, then retry.',
      fix: { kind: 'azure', cli, command: extractAzLogin(raw) || 'az login' },
    };
  }
  if (/aws sso login|sso.*expired|expiredtoken|token has expired|ssotokenprovider/.test(s) || (provider === 'aws' && /token|expired|credential/.test(s))) {
    return {
      title: 'AWS session expired',
      summary: 'Your AWS session has expired. Sign in again to refresh your credentials, then retry.',
      fix: { kind: 'aws', command: extractAwsSso(raw) || 'aws sso login' },
    };
  }
  if (reason === 'exec-plugin' || /executable\s+\S+\s+not found|exec:.*not found|kubelogin|no such file/.test(s)) {
    const note = 'Or install the helper this cluster needs (e.g. kubelogin, aws-iam-authenticator, or gke-gcloud-auth-plugin) and make sure it is on your PATH, then retry.';
    return {
      title: 'Auth helper not found',
      summary: "A credential helper CLI referenced by your kubeconfig isn't installed or isn't on PATH.",
      fix: (provider === 'aws' || provider === 'azure') ? { kind: provider, note } : { kind: 'note', note },
    };
  }
  if (reason === 'tls' || /x509|certificate|tls handshake/.test(s)) {
    return { title: 'TLS certificate error', summary: "The API server's TLS certificate could not be verified. Check that your kubeconfig trusts the right CA.", fix: null };
  }
  if (reason === 'unreachable' || /dial tcp|no such host|i\/o timeout|connection refused|network is unreachable|timeout/.test(s)) {
    return { title: 'Cluster unreachable', summary: "The cluster's API server can't be reached. Check your VPN and network, and that the cluster is running.", fix: null };
  }
  if (/forbidden|is not allowed|cannot list|\b403\b/.test(s)) {
    return { title: 'Access denied', summary: 'Your credentials are valid, but they lack permission on this cluster. Ask for access or switch to a context that has it.', fix: null };
  }
  return { title: TITLES[reason] || TITLES.error, summary: raw || 'The cluster could not be reached with the current kubeconfig.', fix: null, unmatched: true };
}

export default function AuthErrorModal({ open = true, auth, onRetry, onChangeConfig, retrying, contexts = [], contextsInfo, currentContext, onSwitchContext, onAddAzure, onAddAws, onDemo }) {
  // `detail` carries the exec plugin's raw stderr when the backend replaced the
  // message with a friendlier one (sso-expired / exec-helper).
  const raw = auth?.detail || auth?.message || '';
  const { title, summary, fix, unmatched } = classify(auth);
  const [copied, setCopied] = useState(null); // 'cmd' | 'raw'
  const [addMenu, setAddMenu] = useState(null); // { x, y }
  const addRef = useRef(null);

  const canAdd = onChangeConfig || onAddAzure || onAddAws;
  // Only surface the raw error separately when it isn't already the summary.
  const showRaw = !!raw && (!unmatched || raw.length > 160);

  const copy = (text, which) => {
    try { navigator.clipboard?.writeText(text); setCopied(which); setTimeout(() => setCopied(null), 1500); } catch { /* ignore */ }
  };

  const openAdd = () => {
    const r = addRef.current?.getBoundingClientRect();
    setAddMenu({ x: r ? r.left : 0, y: r ? r.bottom + 4 : 0 });
  };
  const addItems = [
    onAddAws && { label: 'AWS EKS', icon: 'aws', onSelect: () => onAddAws() },
    onAddAzure && { label: 'Azure AKS', icon: 'azure', onSelect: () => onAddAzure() },
    onChangeConfig && { label: 'Local — load kubeconfig', icon: 'box', onSelect: () => onChangeConfig() },
  ].filter(Boolean);

  return (
    <Modal
      open={open}
      title={title}
      icon="warning"
      danger
      size="md"
      className="auth-modal"
      showClose={false}
      closeOnBackdrop={false}
      closeOnEscape={false}
      description={summary}
      footer={(
        <div className="auth-actions">
          {onDemo && (
            <Button variant="secondary" icon="sparkles" onClick={onDemo} disabled={retrying} className="btn-demo" title="Explore a synthetic cluster — no real cluster needed">Demo</Button>
          )}
          {canAdd && (
            <>
              <Button ref={addRef} variant="secondary" icon="plus" onClick={openAdd} disabled={retrying} aria-haspopup="menu" aria-expanded={!!addMenu} className="btn-add">
                Add cluster
              </Button>
              {addMenu && <Menu open x={addMenu.x} y={addMenu.y} items={addItems} ariaLabel="Add cluster" returnFocusTo={addRef.current} onClose={() => setAddMenu(null)} />}
            </>
          )}
          <Button variant="primary" icon="refresh" onClick={onRetry} busy={retrying} className="auth-retry">
            {retrying ? 'Retrying…' : 'Retry'}
          </Button>
        </div>
      )}
    >
      {fix && (
        <div className="auth-fix">
          {(fix.kind === 'azure' || fix.kind === 'aws') && (
            <Button
              variant="primary"
              icon={fix.kind === 'azure' ? 'azure' : 'aws'}
              className="auth-fix-btn"
              onClick={() => (fix.kind === 'azure' ? onAddAzure?.(fix.cli ? 'az' : undefined) : onAddAws?.())}
              disabled={retrying || (fix.kind === 'azure' ? !onAddAzure : !onAddAws)}
            >
              {fix.label || `Sign in to ${fix.kind === 'azure' ? 'Azure' : 'AWS'}`}
            </Button>
          )}
          {fix.command && (
            <div className="auth-fix-cmd">
              <span className="auth-fix-cmd-label">or run</span>
              <code title={fix.command}>{fix.command}</code>
              <Button variant="ghost" size="sm" icon={copied === 'cmd' ? 'check' : 'copy'} className="auth-copy" onClick={() => copy(fix.command, 'cmd')} aria-live="polite">
                {copied === 'cmd' ? 'Copied' : 'Copy'}
              </Button>
            </div>
          )}
          {fix.note && <p className="auth-fix-note">{fix.note}</p>}
        </div>
      )}

      <dl className="auth-detail">
        {auth?.currentContext && (
          <div className="auth-detail-row">
            <dt className="auth-detail-key">Context</dt>
            <dd><code>{auth.currentContext}</code></dd>
          </div>
        )}
        {auth?.server && (
          <div className="auth-detail-row">
            <dt className="auth-detail-key">API server</dt>
            <dd><code>{auth.server}</code></dd>
          </div>
        )}
      </dl>

      {showRaw && (
        <details className="auth-details">
          <summary><Icon name="chevronRight" size={13} className="auth-details-caret" /> Technical details</summary>
          <div className="auth-raw-wrap">
            <Button variant="ghost" size="sm" iconOnly icon={copied === 'raw' ? 'check' : 'copy'} ariaLabel="Copy error" className="auth-copy auth-raw-copy" onClick={() => copy(raw, 'raw')} />
            <pre className="auth-raw">{raw}</pre>
          </div>
        </details>
      )}

      {onSwitchContext && contexts.length > 1 && (
        <div className="auth-switch">
          <span className="auth-switch-label" id="auth-switch-label">Switch to another cluster</span>
          <ContextSelector
            contexts={contexts}
            contextsInfo={contextsInfo}
            currentContext={currentContext || auth?.currentContext}
            onChange={onSwitchContext}
            onAddAzure={onAddAzure}
            onAddAws={onAddAws}
            label="Switch to another cluster"
          />
        </div>
      )}
    </Modal>
  );
}
