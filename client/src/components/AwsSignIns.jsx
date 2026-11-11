import { useId, useState } from 'react';
import Icon from './Icons';
import Button from './ui/Button';
import Badge from './ui/Badge';
import { ConfirmModal } from './ui/Modal';
import useRequest from '../hooks/useRequest';
import { getJson, postJson, p, errorMessage, notifyClusterAuthRequired } from '../lib/api';
import { maskAccountId, redactSensitive } from '../lib/redact';

// Preferences → Cloud Integrations: the AWS IAM Identity Center sign-ins
// behind the EKS clusters (GET /api/aws/sessions), one per AWS account. A
// sign-in is stored and used for its own account only, so signing in for one
// account never signs in another, even on the same access portal. Sign out
// removes an account's stored token from this computer. A sign-in the user
// set up in the AWS CLI can still be shared by several accounts; it is split
// by account on request (POST /api/aws/sessions/split). Account ids and the
// start URL are masked.

const hhmm = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};
const hostOf = (url) => {
  try { return redactSensitive(new URL(url).host); } catch { return ''; }
};
const listOf = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

// `refreshable` is a local guess (a refresh token is stored). Once AWS has
// refused to renew it (`renewalRefused`), the Identity Center session is over
// and opening a cluster asks for a sign-in instead.
export function signInStatus(g) {
  if (g.signedIn) return { tone: 'ok', text: `Signed in until ${hhmm(g.expiresAt)}` };
  if (g.refreshable) return { tone: 'muted', text: 'Renews when you open one of its clusters' };
  if (g.expiresAt) return { tone: 'warn', text: 'Expired — sign in when you open one of its clusters' };
  return { tone: 'warn', text: 'Not signed in — sign in when you open one of its clusters' };
}

/** "Account ••••8296", or what it is while several accounts still share it. */
export const signInTitle = (g) => (g.accountId ? `Account ${maskAccountId(g.accountId)}` : `AWS sign-in shared by ${g.accounts} accounts`);

function SignInCard({ g, onAsk }) {
  const st = signInStatus(g);
  const title = signInTitle(g);
  const origin = g.legacy ? ' · older profile format' : !g.managed ? ' · from your AWS CLI configuration' : '';
  return (
    <div className="awsi-card">
      <div className="awsi-head">
        <Icon name="aws" size={18} />
        <div className="awsi-title">
          <strong>{title}</strong>
          <span className="awsi-sub">{hostOf(g.startUrl)}{origin}</span>
        </div>
        <Badge tone={st.tone} size="sm">{st.text}</Badge>
        {/* Enabled while a token (even an expired one) is stored on this computer. */}
        <Button variant="secondary" size="sm" disabled={!g.expiresAt} onClick={() => onAsk({ kind: 'signOut', group: g })}>
          Sign out
        </Button>
      </div>
      {g.canSplit && (
        <div className="awsi-note">
          <span>
            {g.accounts > 1
              ? `${g.accounts} accounts share this sign-in, the way your AWS CLI is set up.`
              : 'This sign-in comes from your AWS CLI configuration, where other accounts can share it.'}
          </span>
          <Button variant="secondary" size="sm" onClick={() => onAsk({ kind: 'split', group: g })}>Use one sign-in per account</Button>
        </div>
      )}
      <ul className="awsi-clusters" aria-label={`Clusters of ${title}`}>
        {g.clusters.map((c) => (
          <li key={c.context} className="awsi-cluster">
            <span className="awsi-cluster-name">
              {c.context}
              {c.current && <Badge tone="info" size="sm">current</Badge>}
            </span>
            <span className="awsi-cluster-meta">
              {[!g.accountId && c.accountId && `Account ${maskAccountId(c.accountId)}`, c.roleName].filter(Boolean).join(' · ')}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What a confirmation says, for each kind of change. */
function confirmCopy(ask) {
  const names = ask.group.clusters.map((c) => c.context);
  if (ask.kind === 'signOut') {
    return {
      title: ask.group.accountId ? `Sign out of account ${maskAccountId(ask.group.accountId)}?` : 'Sign out of this AWS sign-in?',
      message: `Its stored token is removed from this computer: ${listOf(names)} will ask you to sign in again. Other accounts stay signed in, and your browser's AWS access portal session is not affected.`,
      confirmLabel: 'Sign out',
      danger: true,
    };
  }
  const moving = ask.group.clusters.filter((c) => c.canSplit).map((c) => c.context);
  return {
    title: 'Use one sign-in per account?',
    message: `The AWS profiles of ${listOf(moving)} in ~/.aws/config move to a sign-in of their own account (a backup of the file is kept). Each account then asks you to sign in once, and the AWS CLI no longer shares its sign-in with these profiles.`,
    confirmLabel: 'Use one sign-in per account',
  };
}

export default function AwsSignIns() {
  const id = useId();
  const req = useRequest(({ signal }) => getJson(p('api', 'aws', 'sessions'), { signal }), { dedupeKey: 'aws:sessions' });
  const [ask, setAsk] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const signIns = req.data?.signIns || [];

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await postJson(p('api', 'aws', 'sessions', ask.kind === 'signOut' ? 'sign-out' : 'split'), { id: ask.group.id });
      setAsk(null);
      req.refetch();
      // The open cluster lost its sign-in (signed out, or now on its own
      // account's sign-in, not signed in yet): ask for a sign-in right away.
      if (out?.current) notifyClusterAuthRequired({ reason: ask.kind });
    } catch (e) {
      setError(errorMessage(e, 'The change could not be saved.'));
      setAsk(null);
    } finally {
      setBusy(false);
    }
  };

  let body;
  if (req.error && !req.data) body = <p className="prefs-muted" role="alert">{errorMessage(req.error, 'Could not read the AWS sign-ins.')}</p>;
  else if (!req.data) body = <p className="prefs-muted">Loading AWS sign-ins…</p>;
  else if (!signIns.length) body = <p className="prefs-muted">No cluster in your kubeconfig signs in with AWS IAM Identity Center.</p>;
  else body = signIns.map((g) => <SignInCard key={g.id} g={g} onAsk={setAsk} />);

  const copy = ask ? confirmCopy(ask) : null;
  return (
    <section className="awsi" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="awsi-h">AWS sign-ins</h2>
      <p className="prefs-muted awsi-lead">
        Each AWS account has its own sign-in. Signing in for one account never signs in another, even when they use the same access portal.
      </p>
      {error && <p className="awsi-error" role="alert">{error}</p>}
      {body}
      {copy && (
        <ConfirmModal
          open
          title={copy.title}
          message={copy.message}
          confirmLabel={copy.confirmLabel}
          danger={copy.danger}
          busy={busy}
          onConfirm={apply}
          onCancel={() => setAsk(null)}
        />
      )}
    </section>
  );
}
