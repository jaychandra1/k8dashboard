import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Icon from './Icons';
import Loader from './Loader';
import Modal from './ui/Modal';
import Button from './ui/Button';
import { getJson, postJson, errorMessage } from '../lib/api';
import { maskEmail } from '../lib/redact';

const keyOf = (c) => `${c.project}/${c.location}/${c.name}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// Already in the kubeconfig, or its name belongs to another cluster there.
const isLocked = (c) => !!c.imported || !!c.conflict;

// Google GKE integration: the Google account signed in to the gcloud CLI finds
// the GKE clusters of every project it can see, and the chosen ones are merged
// into the kubeconfig (GET /api/gke/status, /clusters; POST /login, /import).
// K8Board has no Google sign-in of its own: "Sign in with Google" runs
// `gcloud auth login`, which opens the browser. Account names are masked.
export default function GkeIntegration({ onClose, onImported }) {
  const id = useId();
  const [phase, setPhase] = useState('checking'); // checking | not-installed | login | listing | list | importing | done
  const [signingIn, setSigningIn] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [account, setAccount] = useState('');
  const [clusters, setClusters] = useState([]);
  const [found, setFound] = useState({ projects: 0, skipped: 0 });
  const [sel, setSel] = useState(() => new Set());
  const [filter, setFilter] = useState('');
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const pollRef = useRef(null);

  const loadClusters = useCallback(async (acct) => {
    setPhase('listing'); setError(null); setSigningIn(false);
    try {
      const data = await getJson('/api/gke/clusters', { params: acct ? { account: acct } : {} });
      const list = data.clusters || [];
      setClusters(list);
      setFound({ projects: data.projects || 0, skipped: data.skipped || 0 });
      setSel(new Set(list.filter((c) => !isLocked(c)).map(keyOf)));
      setPhase('list');
    } catch (e) {
      setError(errorMessage(e));
      // The gcloud sign-in ran out (or was never made for this account): sign in again.
      setPhase(e?.status === 401 ? 'login' : 'list');
    }
  }, []);

  const checkStatus = useCallback(async () => {
    setPhase('checking'); setError(null);
    try {
      const data = await getJson('/api/gke/status');
      if (!data.installed) return setPhase('not-installed');
      const list = data.accounts || [];
      setAccounts(list);
      if (!list.length) return setPhase('login');
      const active = data.account || list[0].account;
      setAccount(active);
      return loadClusters(active);
    } catch (e) { setError(errorMessage(e)); return setPhase('not-installed'); }
  }, [loadClusters]);

  useEffect(() => { checkStatus(); return () => clearInterval(pollRef.current); }, [checkStatus]);

  const startLogin = useCallback(async () => {
    setError(null); setSigningIn(true); setPhase('login');
    try {
      await postJson('/api/gke/login');
      clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const s = await getJson('/api/gke/login/status');
          if (s.status === 'done') { clearInterval(pollRef.current); checkStatus(); }
          else if (s.status === 'error' || s.status === 'idle') { clearInterval(pollRef.current); setSigningIn(false); setError(s.error || 'The Google sign-in did not finish. Try again.'); }
        } catch { /* keep polling */ }
      }, 2000);
    } catch (e) { setSigningIn(false); setError(errorMessage(e)); }
  }, [checkStatus]);

  const pickAccount = (acct) => { setAccount(acct); loadClusters(acct); };

  const doImport = async () => {
    const chosen = clusters.filter((c) => sel.has(keyOf(c)));
    if (!chosen.length) return;
    setPhase('importing'); setError(null);
    try {
      const data = await postJson('/api/gke/import', { clusters: chosen.map((c) => ({ project: c.project, location: c.location, name: c.name })) });
      setResult(data);
      setPhase('done');
      onImported?.(data.contexts);
    } catch (e) { setError(errorMessage(e)); setPhase('list'); }
  };

  const cancelAndClose = () => {
    clearInterval(pollRef.current);
    if (signingIn) postJson('/api/gke/login/cancel').catch(() => {});
    onClose();
  };

  const q = filter.toLowerCase();
  const visible = clusters.filter((c) => !q || [c.name, c.project, c.projectName, c.location].some((v) => String(v || '').toLowerCase().includes(q)));
  const selectableVisible = visible.filter((c) => !isLocked(c));
  const allVisibleSelected = selectableVisible.length > 0 && selectableVisible.every((c) => sel.has(keyOf(c)));
  const toggle = (c) => setSel((s) => { const n = new Set(s); const k = keyOf(c); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const toggleAll = () => setSel((s) => {
    const n = new Set(s);
    if (allVisibleSelected) selectableVisible.forEach((c) => n.delete(keyOf(c)));
    else selectableVisible.forEach((c) => n.add(keyOf(c)));
    return n;
  });
  const selCount = sel.size;

  return (
    <Modal open onClose={cancelAndClose} title="Add Google GKE clusters" icon="hexagon" size="lg" className="azure-modal">
      {error && <div className="azure-error" role="alert"><Icon name="warning" size={14} /> {error}</div>}

      {phase === 'checking' && <div className="azure-center"><Loader label="Checking your Google sign-in…" /></div>}

      {phase === 'not-installed' && (
        <div className="azure-center azure-msg">
          <Icon name="warning" size={22} />
          <p>The Google Cloud CLI (<code>gcloud</code>) isn&apos;t installed, or isn&apos;t on PATH.</p>
          <p className="azure-dim">K8Board finds your GKE clusters with your gcloud sign-in. Install it from <a className="azure-link" href="https://cloud.google.com/sdk/docs/install" target="_blank" rel="noreferrer noopener">cloud.google.com/sdk</a>, then try again.</p>
          <Button onClick={checkStatus}>Retry</Button>
        </div>
      )}

      {phase === 'login' && (
        <div className="azure-center azure-msg">
          <Icon name="hexagon" size={28} />
          {!signingIn ? (
            <>
              <p>Sign in to Google to find the GKE clusters you can access.</p>
              <Button variant="primary" onClick={startLogin}>Sign in with Google</Button>
              <p className="azure-dim">This runs <code>gcloud auth login</code>, which opens your browser. K8Board uses that sign-in and keeps no Google password or token of its own.</p>
            </>
          ) : (
            <>
              <p>A browser window opened for Google sign-in. Pick your account and finish it there.</p>
              <div className="azure-waiting"><Loader label="Waiting for sign-in to complete…" /></div>
            </>
          )}
        </div>
      )}

      {phase === 'listing' && <div className="azure-center"><Loader label="Finding GKE clusters in your Google Cloud projects…" /></div>}

      {phase === 'list' && (
        <>
          <div className="azure-toolbar">
            {accounts.length > 1 && (
              <>
                <label htmlFor={`${id}-account`} className="sr-only">Google account</label>
                <select id={`${id}-account`} className="aws-input gke-account" value={account} onChange={(e) => pickAccount(e.target.value)}>
                  {accounts.map((a) => <option key={a.account} value={a.account}>{maskEmail(a.account)}</option>)}
                </select>
              </>
            )}
            <label htmlFor={`${id}-filter`} className="sr-only">Filter clusters</label>
            <input id={`${id}-filter`} type="search" className="azure-search" placeholder="Filter by name, project or location…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <span className="azure-count" aria-live="polite">
              {plural(clusters.length, 'cluster')} · {plural(found.projects, 'project')}
              {found.skipped > 0 && <span title="Projects where the Kubernetes Engine API is off, or where you may not list clusters"> · {found.skipped} skipped</span>}
            </span>
          </div>
          <div className="azure-list" role="group" aria-label="GKE clusters">
            {visible.length === 0 ? (
              <div className="azure-empty">{clusters.length === 0 ? 'No GKE clusters found for this Google account.' : 'No clusters match your filter.'}</div>
            ) : (
              <>
                <label className="azure-row azure-selall">
                  <input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} disabled={selectableVisible.length === 0} />
                  <span className="azure-selall-label">Select all</span>
                </label>
                {visible.map((c) => (
                  <label key={keyOf(c)} className={`azure-row ${isLocked(c) ? 'imported' : ''}`}>
                    <input type="checkbox" checked={c.imported || sel.has(keyOf(c))} disabled={isLocked(c)} onChange={() => toggle(c)} aria-label={`${c.name} in ${c.projectName || c.project}`} />
                    <span className="azure-cluster">
                      <span className="azure-cname">{c.name}</span>
                      <span className="azure-cmeta">{c.projectName || c.project} · {c.location}{c.version ? ` · v${c.version}` : ''}</span>
                    </span>
                    {c.imported
                      ? <span className="azure-badge added"><Icon name="check" size={12} strokeWidth={2.6} /> Added</span>
                      : c.conflict
                        ? <span className="azure-badge muted" title="Another cluster in your kubeconfig already has this name, so this one can't be added">Name in use</span>
                        : c.private
                          ? <span className="azure-badge muted" title="No public endpoint: reachable only from its own network (VPN)">Private</span>
                          : c.status && c.status !== 'RUNNING'
                            ? <span className="azure-badge muted">{c.status}</span> : null}
                  </label>
                ))}
              </>
            )}
          </div>
          <div className="action-modal-actions">
            <Button variant="ghost" className="action-skip" onClick={startLogin}>Use another Google account</Button>
            <Button variant="secondary" onClick={cancelAndClose}>Cancel</Button>
            <Button variant="primary" disabled={selCount === 0} onClick={doImport}>Add {plural(selCount, 'cluster')}</Button>
          </div>
        </>
      )}

      {phase === 'importing' && <div className="azure-center"><Loader label="Adding clusters to your kubeconfig…" /></div>}

      {phase === 'done' && (
        <div className="azure-center azure-msg" role="status">
          <div className="azure-done-icon"><Icon name="check" size={26} strokeWidth={2.6} /></div>
          <p><b>{result?.imported?.length || 0}</b> cluster{(result?.imported?.length || 0) === 1 ? '' : 's'} added to your kubeconfig.</p>
          {result?.failed?.length > 0 && (
            <div className="azure-failed">
              {result.failed.map((f) => <div key={f.name}><b>{f.name}</b>: {f.error}</div>)}
            </div>
          )}
          <p className="azure-dim">They&apos;re now on Home and in the cluster menu. kubectl uses your gcloud sign-in for them too.</p>
          <Button variant="primary" onClick={onClose}>Done</Button>
        </div>
      )}
    </Modal>
  );
}
