import { useState } from 'react';
import Icon from './Icons';
import { PROVIDERS, providerKeyOf } from './ContextPickerModal';
import { useSsoSignIn, SsoSignInPanel } from './AwsSsoSignIn';
import { maskAccountId, redactSensitive } from '../lib/redact';
import Modal from './ui/Modal';
import Button from './ui/Button';

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

// "Public endpoint" / "Private cluster" for the cluster card.
export const ENDPOINT_LABEL = { public: 'Public endpoint', private: 'Private cluster', local: 'Local' };

// A private cluster that doesn't answer: the user isn't on its network. Say
// that and what to do — no timeouts, endpoints or diagnostics.
export const PRIVATE_CLUSTER_NOTICE = {
  title: 'Cluster access restricted',
  summary: 'This cluster is private. Please connect to the required network (VPN/Tailscale) to access it.',
};

// What to try, given which endpoint this machine reached and how it failed.
export function unreachableHint({ endpoint, failure } = {}) {
  if (failure === 'dns') {
    return 'Check your internet connection. If this cluster is only reachable over Tailscale or a VPN, connect it first — the cluster’s name may only resolve there.';
  }
  // (A private cluster gets PRIVATE_CLUSTER_NOTICE instead of a hint.)
  if (endpoint === 'public' && failure !== 'refused') {
    return 'On this computer the cluster’s name resolves to its public endpoint. If you normally reach it through Tailscale or a VPN, connect it and make sure its DNS resolves the cluster to the private endpoint (split DNS). Otherwise this network may not be on the cluster’s allowed public-access IP ranges.';
  }
  if (endpoint === 'local') return 'Start the local cluster (Docker Desktop, kind, minikube…), then retry.';
  return 'Check your network or VPN, and that the cluster is running.';
}

// Classify the failure into { title, summary, fix } where fix describes the
// remediation (a one-click cloud sign-in and/or a copyable CLI command).
export function classify(auth) {
  const out = classifyRaw(auth);
  return out.provider ? out : { ...out, provider: guessProvider(auth) };
}

// The cloud behind an API server URL, from its host name only (a path, query
// or userinfo that mentions a cloud domain doesn't count).
export function providerOfServer(server) {
  const raw = String(server || '').trim();
  if (!raw) return null;
  let host;
  try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase(); } catch { return null; }
  const labels = host.split('.');
  const under = (domain) => host === domain || host.endsWith(`.${domain}`);
  if (under('azmk8s.io') || labels.includes('azure')) return 'azure';
  if (labels.includes('eks')) return 'aws';
  if (labels.includes('gke') || under('gke.goog') || under('container.googleapis.com')) return 'gcp';
  return null;
}

const guessProvider = (auth) => providerOfServer(auth?.server);

function classifyRaw(auth) {
  const reason = auth?.reason || 'error';
  const raw = auth?.message || '';
  const s = raw.toLowerCase();
  const provider = providerOfServer(auth?.server);

  // Server-side classifications of the bundled token helpers come first: the
  // backend has already looked at the exec plugin's stderr / exit status.
  if (reason === 'sso-expired') {
    return {
      title: 'AWS session expired',
      summary: 'Your AWS sign-in for this cluster has ended. Sign in again to reconnect.',
      fix: { kind: 'aws', label: 'Sign in with AWS', command: extractAwsSso(auth?.detail || raw) || 'aws sso login' },
      provider: 'aws',
    };
  }
  if (reason === 'exec-helper') {
    return {
      title: 'Cluster auth helper failed',
      summary: raw || "K8Board's kubeconfig auth helper for this cluster could not produce a token.",
      fix: { kind: 'note', note: 'Stale helper entries are repaired automatically — click Retry. If it keeps failing, re-import the cluster from Add cluster.' },
    };
  }
  // The backend has classified the network failure and which endpoint (private
  // or public) this machine reached — no address is ever included.
  if (reason === 'unreachable') {
    if (auth?.network?.endpoint === 'private' && auth.network.failure !== 'dns') {
      return { ...PRIVATE_CLUSTER_NOTICE, fix: null, plain: true };
    }
    return {
      title: 'Cluster unreachable',
      summary: raw || "The cluster's API server can't be reached.",
      fix: { kind: 'note', note: unreachableHint(auth?.network) },
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
  if (/dial tcp|no such host|i\/o timeout|connection refused|network is unreachable|timeout|fetch failed/.test(s)) {
    return { title: 'Cluster unreachable', summary: "The cluster's API server can't be reached. Check your VPN and network, and that the cluster is running.", fix: null };
  }
  if (/forbidden|is not allowed|cannot list|\b403\b/.test(s)) {
    return { title: 'Access denied', summary: 'Your credentials are valid, but they lack permission on this cluster. Ask for access or switch to a context that has it.', fix: null };
  }
  return { title: TITLES[reason] || TITLES.error, summary: raw || 'The cluster could not be reached with the current kubeconfig.', fix: null, unmatched: true };
}

const fmtEnded = (iso) => {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
};

// The dialog is about the cluster being connected and nothing else. Other
// clusters are on Home, behind it ("Back to clusters"); which clusters an AWS
// sign-in covers (its AWS account's) is in Preferences → Cloud Integrations → AWS sign-ins.
export default function AuthErrorModal({ open = true, auth, onRetry, retrying, contextsInfo, currentContext, onAddAzure, onAddAws, onBack }) {
  // `detail` carries the exec plugin's raw stderr when the backend replaced the
  // message with a friendlier one (sso-expired / exec-helper).
  // Nothing environment-identifying is displayed: account ids, endpoints, IPs,
  // tenant ids and tokens are masked (lib/redact). Copy-to-run commands keep
  // their real values so they still work.
  const raw = redactSensitive(auth?.detail || auth?.message || '');
  const { title, summary: rawSummary, fix, unmatched, plain, provider: errProvider } = classify(auth);
  const summary = redactSensitive(rawSummary);
  const [copied, setCopied] = useState(null); // 'cmd' | 'raw'

  const ctxName = currentContext || auth?.currentContext || '';
  const aws = auth?.aws || null;
  // The backend knows the profile + Identity Center → sign in right here.
  const awsInline = fix?.kind === 'aws' && !!aws?.canSignIn;
  // Let "Signed in" register for a moment, then reconnect.
  const sso = useSsoSignIn({ onDone: () => { setTimeout(() => onRetry?.(), 1200); } });
  const signingIn = ['starting', 'browser', 'device', 'done'].includes(sso.state.phase);

  const provider = providerKeyOf(contextsInfo?.find((c) => c.name === ctxName)?.provider || (aws ? 'aws' : errProvider) || 'other');
  const prov = PROVIDERS[provider];
  const meta = [
    prov.label,
    aws?.accountId && `Account ${maskAccountId(aws.accountId)}`,
    aws?.roleName,
    ENDPOINT_LABEL[auth?.network?.endpoint],
  ].filter(Boolean).join(' · ');
  const ended = aws ? fmtEnded(aws.expiredAt) : null;

  // Only surface the raw error separately when it isn't already the summary,
  // and never under a plain notice (it would only repeat the diagnostics).
  const showRaw = !plain && !!raw && (!unmatched || raw.length > 160);

  const copy = (text, which) => {
    try { navigator.clipboard?.writeText(text); setCopied(which); setTimeout(() => setCopied(null), 1500); } catch { /* ignore */ }
  };

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
          <span className="auth-actions-spacer" />
          {onBack && (
            <Button variant="ghost" icon="arrowLeft" onClick={() => { sso.cancel(); onBack(); }} disabled={retrying}>Back to clusters</Button>
          )}
          <Button variant={awsInline ? 'secondary' : 'primary'} icon="refresh" onClick={onRetry} busy={retrying} disabled={signingIn && sso.state.phase !== 'done'} className="auth-retry">
            {retrying ? 'Retrying…' : 'Retry'}
          </Button>
        </div>
      )}
    >
      <section className="auth-card" data-provider={provider} aria-label={`${ctxName || 'Current cluster'} connection`}>
        <header className="auth-card-head">
          <span className={`auth-provider auth-provider-${provider}`} aria-hidden="true"><Icon name={prov.icon} size={18} /></span>
          <span className="auth-card-id">
            <span className="auth-card-name" title={ctxName}>{ctxName || 'Current cluster'}</span>
            <span className="auth-card-meta">{meta}</span>
          </span>
          <span className="auth-card-tags">
            {ended && <span className="auth-pill" title={aws.expiredAt}>Ended {ended}</span>}
          </span>
        </header>
        {awsInline ? (
          <div className="auth-card-body">
            <SsoSignInPanel
              sso={sso}
              params={{ profile: aws.profile, startUrl: aws.startUrl, ssoRegion: aws.ssoRegion }}
              browser={aws.browser}
              command={fix.command}
              doneText={`Reconnecting to ${ctxName || 'the cluster'}…`}
            />
          </div>
        ) : fix && (
          <div className="auth-card-body auth-fix">
            {(fix.kind === 'azure' || fix.kind === 'aws') && (
              <Button
                variant="primary"
                size="lg"
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
                <code>{redactSensitive(fix.command)}</code>
                <Button variant="ghost" size="sm" icon={copied === 'cmd' ? 'check' : 'copy'} className="auth-copy" onClick={() => copy(fix.command, 'cmd')} aria-live="polite">
                  {copied === 'cmd' ? 'Copied' : 'Copy'}
                </Button>
              </div>
            )}
            {fix.note && <p className="auth-fix-note">{fix.note}</p>}
          </div>
        )}
      </section>

      {showRaw && (
        <details className="auth-details">
          <summary><Icon name="chevronRight" size={13} className="auth-details-caret" /> Technical details</summary>
          <div className="auth-raw-wrap">
            <Button variant="ghost" size="sm" iconOnly icon={copied === 'raw' ? 'check' : 'copy'} ariaLabel="Copy error" className="auth-copy auth-raw-copy" onClick={() => copy(raw, 'raw')} />
            <pre className="auth-raw">{raw}</pre>
          </div>
        </details>
      )}

    </Modal>
  );
}
