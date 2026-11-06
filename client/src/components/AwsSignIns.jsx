import { useId, useState } from 'react';
import Icon from './Icons';
import Button from './ui/Button';
import Badge from './ui/Badge';
import { ConfirmModal } from './ui/Modal';
import useRequest from '../hooks/useRequest';
import { getJson, postJson, p, errorMessage } from '../lib/api';
import { maskAccountId, redactSensitive } from '../lib/redact';

// Preferences → Cloud Integrations: the AWS IAM Identity Center sign-ins
// behind the EKS clusters (GET /api/aws/sessions). One sign-in reaches every
// account and role its user is assigned, so the clusters listed under a
// sign-in share it. A production cluster can have a sign-in of its own
// (POST /api/aws/production), and Sign out removes a sign-in's stored token
// from this computer. Account ids and the start URL are masked.

const hhmm = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};
const hostOf = (url) => {
  try { return redactSensitive(new URL(url).host); } catch { return ''; }
};
const listOf = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

export function signInStatus(g) {
  if (g.signedIn) return { tone: 'ok', text: `Signed in until ${hhmm(g.expiresAt)}` };
  if (g.refreshable) return { tone: 'muted', text: 'Renews when you open one of its clusters' };
  return { tone: 'warn', text: 'Signed out' };
}

function SignInCard({ g, onAsk }) {
  const st = signInStatus(g);
  return (
    <div className={`awsi-card${g.production ? ' awsi-prod' : ''}`}>
      <div className="awsi-head">
        <Icon name="aws" size={18} />
        <div className="awsi-title">
          <strong>{g.production ? 'Production sign-in' : 'AWS sign-in'}</strong>
          <span className="awsi-sub">{hostOf(g.startUrl)}{g.legacy ? ' · older profile format' : ''}</span>
        </div>
        <Badge tone={st.tone} size="sm">{st.text}</Badge>
        <Button variant="secondary" size="sm" disabled={!g.signedIn && !g.refreshable} onClick={() => onAsk({ kind: 'signOut', group: g })}>
          Sign out
        </Button>
      </div>
      <ul className="awsi-clusters" aria-label={`Clusters on this ${g.production ? 'production ' : ''}sign-in`}>
        {g.clusters.map((c) => (
          <li key={c.context} className="awsi-cluster">
            <span className="awsi-cluster-name">
              {c.context}
              {c.current && <Badge tone="info" size="sm">current</Badge>}
            </span>
            <span className="awsi-cluster-meta">{[c.accountId && `Account ${maskAccountId(c.accountId)}`, c.roleName].filter(Boolean).join(' · ')}</span>
            <label className="awsi-prod-toggle">
              <input
                type="checkbox"
                checked={g.production}
                onChange={(e) => onAsk({ kind: 'production', group: g, cluster: c, production: e.target.checked })}
              />
              Production
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What a confirmation says, for each kind of change. */
function confirmCopy(ask) {
  if (ask.kind === 'signOut') {
    const names = ask.group.clusters.map((c) => c.context);
    return {
      title: 'Sign out of this AWS sign-in?',
      message: `Its stored token is removed from this computer: ${listOf(names)} will ask you to sign in again. Your browser's AWS access portal session is not affected.`,
      confirmLabel: 'Sign out',
      danger: true,
    };
  }
  if (ask.kind === 'production') {
    const { cluster, group } = ask;
    const same = group.clusters.filter((c) => c.profile === cluster.profile && c.context !== cluster.context).map((c) => c.context);
    const also = same.length ? ` This also applies to ${listOf(same)}, which use the same AWS account and role.` : '';
    return ask.production ? {
      title: `Mark ${cluster.context} as production?`,
      message: `${cluster.context} gets an AWS sign-in of its own: signing in for other clusters will no longer give access to it, and it asks you to sign in the next time you open it.${also} Its AWS profile (${cluster.profile}) in ~/.aws/config is updated; a backup is kept.`,
      confirmLabel: 'Mark as production',
    } : {
      title: `Use the shared sign-in for ${cluster.context}?`,
      message: `${cluster.context} goes back to the shared AWS sign-in: signing in for any of its clusters gives access to it again.${also} Its separate sign-in is removed from this computer.`,
      confirmLabel: 'Use the shared sign-in',
      danger: true,
    };
  }
  return {
    title: 'Use the shared sign-in for these AWS CLI profiles?',
    message: `${listOf(ask.profiles)} in ~/.aws/config will use the shared AWS sign-in (their format is updated; a backup is kept). The AWS CLI then shares that sign-in too.`,
    confirmLabel: 'Update profiles',
  };
}

export default function AwsSignIns() {
  const id = useId();
  const req = useRequest(({ signal }) => getJson(p('api', 'aws', 'sessions'), { signal }), { dedupeKey: 'aws:sessions' });
  const [ask, setAsk] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const signIns = req.data?.signIns || [];
  const legacy = req.data?.legacyProfiles || [];
  const legacyByUrl = legacy.reduce((m, l) => m.set(l.startUrl, [...(m.get(l.startUrl) || []), l.profile]), new Map());

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      if (ask.kind === 'signOut') await postJson(p('api', 'aws', 'sessions', 'sign-out'), { id: ask.group.id });
      else if (ask.kind === 'production') await postJson(p('api', 'aws', 'production'), { context: ask.cluster.context, production: ask.production });
      else await postJson(p('api', 'aws', 'profiles', 'use-shared-sign-in'), { startUrl: ask.startUrl, profiles: ask.profiles });
      setAsk(null);
      req.refetch();
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
  else if (!signIns.length && !legacy.length) body = <p className="prefs-muted">No cluster in your kubeconfig signs in with AWS IAM Identity Center.</p>;
  else {
    body = (
      <>
        {signIns.map((g) => <SignInCard key={g.id} g={g} onAsk={setAsk} />)}
        {[...legacyByUrl].map(([startUrl, profiles]) => (
          <div key={startUrl} className="awsi-legacy">
            <p className="prefs-muted">
              {profiles.length === 1 ? 'One AWS CLI profile' : `${profiles.length} AWS CLI profiles`} for {hostOf(startUrl)} still use the older format and
              were not changed: <strong>{profiles.join(', ')}</strong>.
            </p>
            <Button variant="secondary" size="sm" onClick={() => setAsk({ kind: 'profiles', startUrl, profiles })}>Use the shared sign-in for them</Button>
          </div>
        ))}
      </>
    );
  }

  const copy = ask ? confirmCopy(ask) : null;
  return (
    <section className="awsi" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="awsi-h">AWS sign-ins</h2>
      <p className="prefs-muted awsi-lead">
        Signing in once gives access to every cluster listed under that sign-in. Mark a production cluster to give it a sign-in of its own, so signing in for another cluster never reaches it.
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
