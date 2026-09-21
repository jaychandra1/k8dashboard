import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Icon from './Icons';
import Loader from './Loader';
import Modal from './ui/Modal';
import Button from './ui/Button';
import { getJson, postJson, errorMessage } from '../lib/api';

const keyOf = (c) => `${c.region}/${c.name}`;

export const ACCESS_KEY_RE = /^(AKIA|ASIA)[A-Z0-9]{16}$/;
export const REGION_RE = /^[a-z]{2}-[a-z]+-\d$/;

/** Labelled field with optional hint + inline error (aria-describedby / aria-invalid wired by the caller via `ids`). */
function Field({ id, label, hint, error, children }) {
  return (
    <div className="aws-field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && !error && <span id={`${id}-hint`} className="aws-field-hint">{hint}</span>}
      {error && <span id={`${id}-err`} className="aws-field-error" role="alert"><Icon name="warning" size={12} /> {error}</span>}
    </div>
  );
}
const describedBy = (id, error, hint) => [error ? `${id}-err` : null, hint && !error ? `${id}-hint` : null].filter(Boolean).join(' ') || undefined;

// One-click AWS EKS integration: sign in (SSO / access keys / assume-role),
// discover every EKS cluster across all regions, and merge chosen ones into the
// kubeconfig. Mirrors the Azure AKS modal.
export default function AwsIntegration({ onClose, onImported }) {
  const id = useId();
  const [phase, setPhase] = useState('checking'); // checking|not-installed|method|sso-login|sso-account|sso-role|listing|list|importing|done
  const [profiles, setProfiles] = useState([]);
  const [method, setMethod] = useState('sso'); // sso | access-key | role
  const [advanced, setAdvanced] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [ssoProfile, setSsoProfile] = useState('');
  const [ssoStartUrl, setSsoStartUrl] = useState('');
  const [ssoRegionField, setSsoRegionField] = useState('');
  const [existingProfile, setExistingProfile] = useState('');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [sessionToken, setSessionToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [region, setRegion] = useState('');
  const [roleArn, setRoleArn] = useState('');
  const [sourceProfile, setSourceProfile] = useState('');
  const [sessionName, setSessionName] = useState('');
  const [device, setDevice] = useState(null);
  const [ssoAccounts, setSsoAccounts] = useState([]);
  const [ssoRoles, setSsoRoles] = useState([]);
  const [chosenAccount, setChosenAccount] = useState('');
  const [chosenRole, setChosenRole] = useState('');
  const [busy, setBusy] = useState(false);
  const [activeProfile, setActiveProfile] = useState(null);
  const [clusters, setClusters] = useState([]);
  const [regionsScanned, setRegionsScanned] = useState(0);
  const [sel, setSel] = useState(() => new Set());
  const [filter, setFilter] = useState('');
  const [error, setError] = useState(null);
  const [touched, setTouched] = useState({});
  const [result, setResult] = useState(null);
  const pollRef = useRef(null);

  const checkStatus = useCallback(async () => {
    setPhase('checking'); setError(null);
    try {
      const data = await getJson('/api/aws/status');
      if (!data.installed) return setPhase('not-installed');
      const ps = data.profiles || [];
      setProfiles(ps);
      if (ps.length) { setSsoProfile(ps[0]); setSourceProfile(ps[0]); setExistingProfile(ps[0]); }
      return setPhase('method');
    } catch (e) { setError(errorMessage(e)); return setPhase('not-installed'); }
  }, []);

  useEffect(() => { checkStatus(); return () => clearInterval(pollRef.current); }, [checkStatus]);

  const loadAccounts = async () => {
    setDevice(null); setError(null); setBusy(true); setPhase('sso-account');
    try {
      const data = await getJson('/api/aws/sso-accounts');
      const accts = data.accounts || [];
      setSsoAccounts(accts);
      if (accts.length) setChosenAccount(accts[0].accountId);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };

  const startSsoLogin = async (profile) => {
    setError(null); setDevice(null); setPhase('sso-login');
    try {
      const data = await postJson('/api/aws/sso-login', { profile: profile || undefined, startUrl: ssoStartUrl || undefined, ssoRegion: ssoRegionField || undefined });
      if (data.error) { setError(data.error); setPhase('method'); return; }
      if (data.userCode) setDevice({ userCode: data.userCode, verificationUrl: data.verificationUrl });
      clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const s = await getJson('/api/aws/sso-login/status');
          if (s.userCode) setDevice((d) => d || { userCode: s.userCode, verificationUrl: s.verificationUrl });
          if (s.status === 'done') { clearInterval(pollRef.current); loadAccounts(); }
          else if (s.status === 'error') { clearInterval(pollRef.current); setPhase('method'); setError(s.error || 'SSO sign-in failed or was cancelled.'); }
        } catch { /* keep polling */ }
      }, 2000);
    } catch (e) { setPhase('method'); setError(errorMessage(e)); }
  };

  const loadRoles = async (accountId) => {
    setError(null); setBusy(true); setPhase('sso-role');
    try {
      const data = await getJson('/api/aws/sso-roles', { params: { account: accountId } });
      const roles = data.roles || [];
      setSsoRoles(roles);
      setChosenRole(roles[0] || '');
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };

  const applyClusters = (data) => {
    const list = data.clusters || [];
    setClusters(list);
    setRegionsScanned(data.regions || 0);
    setSel(new Set(list.filter((c) => !c.imported).map(keyOf)));
    setPhase('list');
  };

  const discoverSso = async (account, role) => {
    setActiveProfile(null);
    setPhase('listing'); setError(null);
    try { applyClusters(await postJson('/api/aws/clusters', { account, role })); }
    catch (e) { setError(errorMessage(e)); setPhase('list'); }
  };

  const discover = async (profile) => {
    setActiveProfile(profile || null);
    setPhase('listing'); setError(null); setDevice(null);
    try { applyClusters(await postJson('/api/aws/clusters', { profile: profile || undefined })); }
    catch (e) { setError(errorMessage(e)); setPhase('list'); }
  };

  // ---- advanced form validation ----
  const v = {
    profileName: !profileName.trim() ? 'Profile name is required.' : null,
    accessKeyId: !accessKeyId ? 'Access key ID is required.' : !ACCESS_KEY_RE.test(accessKeyId) ? 'Must start with AKIA or ASIA followed by 16 uppercase letters/digits.' : null,
    secretKey: !secretKey ? 'Secret access key is required.' : null,
    region: region && !REGION_RE.test(region) ? 'Use a region like us-east-1.' : null,
    ssoRegion: ssoRegionField && !REGION_RE.test(ssoRegionField) ? 'Use a region like us-east-1.' : null,
    roleArn: !roleArn.trim() ? 'Role ARN is required.' : !/^arn:aws[a-z-]*:iam::\d{12}:role\/.+/.test(roleArn.trim()) ? 'Use the form arn:aws:iam::123456789012:role/Name.' : null,
    sourceProfile: !sourceProfile.trim() ? 'Source profile is required.' : null,
  };
  const accessKeyValid = !v.profileName && !v.accessKeyId && !v.secretKey && !v.region;
  const roleValid = !v.profileName && !v.roleArn && !v.sourceProfile && !v.region;
  const formValid = method === 'access-key' ? accessKeyValid : roleValid;
  const show = (k) => (touched[k] ? v[k] : null);
  const touch = (k) => setTouched((t) => ({ ...t, [k]: true }));

  const configureAndDiscover = async (e) => {
    e?.preventDefault?.();
    setTouched({ profileName: true, accessKeyId: true, secretKey: true, region: true, roleArn: true, sourceProfile: true });
    if (!formValid) return;
    setError(null);
    try {
      const body = method === 'access-key'
        ? { method, name: profileName.trim(), accessKeyId, secretAccessKey: secretKey, sessionToken, region: region || undefined }
        : { method: 'role', name: profileName.trim(), roleArn: roleArn.trim(), sourceProfile: sourceProfile.trim(), sessionName, region: region || undefined };
      const data = await postJson('/api/aws/configure', body);
      discover(data.profile);
    } catch (err) { setError(errorMessage(err)); }
  };

  const doImport = async () => {
    const chosen = clusters.filter((c) => sel.has(keyOf(c)));
    if (!chosen.length) return;
    setPhase('importing'); setError(null);
    try {
      const data = await postJson('/api/aws/import', { clusters: chosen.map((c) => ({ name: c.name, region: c.region })), profile: activeProfile || undefined });
      setResult(data); setPhase('done'); onImported?.(data.contexts);
    } catch (e) { setError(errorMessage(e)); setPhase('list'); }
  };

  const cancelAndClose = () => {
    clearInterval(pollRef.current);
    if (phase === 'sso-login') postJson('/api/aws/sso-login/cancel').catch(() => {});
    onClose();
  };

  // Signed in but not importing — e.g. the user only needed to refresh expired
  // AWS credentials to fix the current cluster. Re-check auth and close.
  const skip = () => { clearInterval(pollRef.current); onImported?.(); onClose(); };

  const q = filter.toLowerCase();
  const visible = clusters.filter((c) => !q || c.name.toLowerCase().includes(q) || c.region.toLowerCase().includes(q));
  const selectable = visible.filter((c) => !c.imported);
  const allSelected = selectable.length > 0 && selectable.every((c) => sel.has(keyOf(c)));
  const toggle = (c) => setSel((s) => { const n = new Set(s); const k = keyOf(c); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const toggleAll = () => setSel((s) => { const n = new Set(s); if (allSelected) selectable.forEach((c) => n.delete(keyOf(c))); else selectable.forEach((c) => n.add(keyOf(c))); return n; });

  const f = (k) => `${id}-${k}`;

  return (
    <Modal open onClose={cancelAndClose} title="Add AWS EKS clusters" icon="aws" size="lg" className="azure-modal">
      {error && <div className="azure-error" role="alert"><Icon name="warning" size={14} /> {error}</div>}

      {phase === 'checking' && <div className="azure-center"><Loader label="Checking AWS CLI…" /></div>}

      {phase === 'not-installed' && (
        <div className="azure-center azure-msg">
          <Icon name="warning" size={22} />
          <p>The AWS CLI (<code>aws</code>) isn't installed or isn't on this server's PATH.</p>
          <p className="azure-dim">Install it, then reopen this dialog. See <a className="azure-link" href="https://aws.amazon.com/cli/" target="_blank" rel="noreferrer noopener">aws.amazon.com/cli</a></p>
          <Button onClick={checkStatus}>Retry</Button>
        </div>
      )}

      {phase === 'method' && (
        <>
          <div className="aws-sso-primary">
            <div className="aws-sso-head">
              <span className="aws-sso-icon"><Icon name="aws" size={20} /></span>
              <div>
                <div className="aws-sso-title">Sign in with AWS SSO <span className="aws-rec">Recommended</span></div>
                <div className="azure-dim">IAM Identity Center — sign in in the browser and authorize access.</div>
              </div>
            </div>
            {profiles.length > 0 && (
              <Field id={f('sso-profile')} label="SSO profile (optional)">
                <select id={f('sso-profile')} className="aws-input" value={ssoProfile} onChange={(e) => setSsoProfile(e.target.value)}>
                  <option value="">— enter start URL below —</option>
                  {profiles.map((pr) => <option key={pr} value={pr}>{pr}</option>)}
                </select>
              </Field>
            )}
            {!ssoProfile && (
              <>
                <Field id={f('sso-url')} label="AWS SSO start URL">
                  <input id={f('sso-url')} className="aws-input" type="url" placeholder="https://my-org.awsapps.com/start" value={ssoStartUrl} onChange={(e) => setSsoStartUrl(e.target.value)} autoComplete="off" spellCheck={false} required aria-required="true" />
                </Field>
                <Field id={f('sso-region')} label="SSO region (optional)" hint="e.g. us-east-1" error={show('ssoRegion')}>
                  <input id={f('sso-region')} className="aws-input" placeholder="e.g. us-east-1" value={ssoRegionField} onChange={(e) => setSsoRegionField(e.target.value.trim())} onBlur={() => touch('ssoRegion')} pattern="^[a-z]{2}-[a-z]+-\d$" aria-invalid={show('ssoRegion') ? 'true' : undefined} aria-describedby={describedBy(f('sso-region'), show('ssoRegion'), 'e.g. us-east-1')} autoComplete="off" spellCheck={false} />
                </Field>
              </>
            )}
            <div className="aws-sso-actions">
              <Button variant="primary" onClick={() => startSsoLogin(ssoProfile)} disabled={(!ssoProfile && !ssoStartUrl.trim()) || !!v.ssoRegion}>Sign in with AWS SSO</Button>
              {profiles.length > 0 && <button type="button" className="azure-alt" onClick={() => discover(existingProfile)}>Skip — already signed in, just discover clusters</button>}
            </div>
          </div>

          <button type="button" className="aws-advanced-toggle" aria-expanded={advanced} aria-controls={f('advanced')} onClick={() => { setAdvanced((a) => !a); if (method === 'sso') setMethod('access-key'); }}>
            <Icon name={advanced ? 'chevronDown' : 'chevronRight'} size={13} strokeWidth={2.2} /> Advanced options
          </button>
          {advanced && (
            <form id={f('advanced')} className="aws-advanced" onSubmit={configureAndDiscover} noValidate>
              <div className="aws-tabs" role="tablist" aria-label="Credential method">
                <button type="button" role="tab" aria-selected={method === 'access-key'} className={`aws-tab ${method === 'access-key' ? 'on' : ''}`} onClick={() => setMethod('access-key')}>Access key<span>IAM user</span></button>
                <button type="button" role="tab" aria-selected={method === 'role'} className={`aws-tab ${method === 'role' ? 'on' : ''}`} onClick={() => setMethod('role')}>IAM role<span>Assume role</span></button>
              </div>

              {method === 'access-key' && (
                <div className="aws-form">
                  <Field id={f('name')} label="Profile name" error={show('profileName')}>
                    <input id={f('name')} className="aws-input" placeholder="e.g. my-eks" value={profileName} onChange={(e) => setProfileName(e.target.value)} onBlur={() => touch('profileName')} required aria-required="true" aria-invalid={show('profileName') ? 'true' : undefined} aria-describedby={describedBy(f('name'), show('profileName'))} autoComplete="off" />
                  </Field>
                  <Field id={f('akid')} label="Access Key ID" error={show('accessKeyId')}>
                    <input id={f('akid')} className="aws-input" autoComplete="off" spellCheck={false} value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value.trim())} onBlur={() => touch('accessKeyId')} required aria-required="true" pattern="^(AKIA|ASIA)[A-Z0-9]{16}$" aria-invalid={show('accessKeyId') ? 'true' : undefined} aria-describedby={describedBy(f('akid'), show('accessKeyId'))} />
                  </Field>
                  <Field id={f('secret')} label="Secret Access Key" error={show('secretKey')}>
                    <input id={f('secret')} className="aws-input" type="password" autoComplete="off" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} onBlur={() => touch('secretKey')} required aria-required="true" aria-invalid={show('secretKey') ? 'true' : undefined} aria-describedby={describedBy(f('secret'), show('secretKey'))} />
                  </Field>
                  <Field id={f('token')} label="Session Token (optional)">
                    <div className="aws-input-row">
                      <input id={f('token')} className="aws-input" type={showToken ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={sessionToken} onChange={(e) => setSessionToken(e.target.value)} />
                      <Button variant="ghost" size="sm" iconOnly icon={showToken ? 'eyeOff' : 'eye'} ariaLabel={showToken ? 'Hide session token' : 'Show session token'} aria-pressed={showToken} onClick={() => setShowToken((s) => !s)} />
                    </div>
                  </Field>
                  <Field id={f('region')} label="Default region (optional)" hint="e.g. us-east-1" error={show('region')}>
                    <input id={f('region')} className="aws-input" placeholder="e.g. us-east-1" value={region} onChange={(e) => setRegion(e.target.value.trim())} onBlur={() => touch('region')} pattern="^[a-z]{2}-[a-z]+-\d$" aria-invalid={show('region') ? 'true' : undefined} aria-describedby={describedBy(f('region'), show('region'), 'e.g. us-east-1')} autoComplete="off" spellCheck={false} />
                  </Field>
                </div>
              )}

              {method === 'role' && (
                <div className="aws-form">
                  <Field id={f('rname')} label="Profile name" error={show('profileName')}>
                    <input id={f('rname')} className="aws-input" placeholder="e.g. eks-role" value={profileName} onChange={(e) => setProfileName(e.target.value)} onBlur={() => touch('profileName')} required aria-required="true" aria-invalid={show('profileName') ? 'true' : undefined} aria-describedby={describedBy(f('rname'), show('profileName'))} autoComplete="off" />
                  </Field>
                  <Field id={f('source')} label="Source profile" error={show('sourceProfile')}>
                    {profiles.length
                      ? <select id={f('source')} className="aws-input" value={sourceProfile} onChange={(e) => setSourceProfile(e.target.value)} required aria-required="true">{profiles.map((pr) => <option key={pr} value={pr}>{pr}</option>)}</select>
                      : <input id={f('source')} className="aws-input" placeholder="e.g. default" value={sourceProfile} onChange={(e) => setSourceProfile(e.target.value)} onBlur={() => touch('sourceProfile')} required aria-required="true" aria-invalid={show('sourceProfile') ? 'true' : undefined} aria-describedby={describedBy(f('source'), show('sourceProfile'))} autoComplete="off" />}
                  </Field>
                  <Field id={f('arn')} label="Role ARN" error={show('roleArn')}>
                    <input id={f('arn')} className="aws-input" placeholder="arn:aws:iam::123456789012:role/EKSAccess" value={roleArn} onChange={(e) => setRoleArn(e.target.value)} onBlur={() => touch('roleArn')} required aria-required="true" aria-invalid={show('roleArn') ? 'true' : undefined} aria-describedby={describedBy(f('arn'), show('roleArn'))} autoComplete="off" spellCheck={false} />
                  </Field>
                  <Field id={f('sess')} label="Session name (optional)">
                    <input id={f('sess')} className="aws-input" value={sessionName} onChange={(e) => setSessionName(e.target.value)} autoComplete="off" />
                  </Field>
                  <Field id={f('rregion')} label="Default region (optional)" hint="e.g. us-east-1" error={show('region')}>
                    <input id={f('rregion')} className="aws-input" placeholder="e.g. us-east-1" value={region} onChange={(e) => setRegion(e.target.value.trim())} onBlur={() => touch('region')} pattern="^[a-z]{2}-[a-z]+-\d$" aria-invalid={show('region') ? 'true' : undefined} aria-describedby={describedBy(f('rregion'), show('region'), 'e.g. us-east-1')} autoComplete="off" spellCheck={false} />
                  </Field>
                </div>
              )}
            </form>
          )}

          <div className="action-modal-actions">
            <Button variant="secondary" onClick={cancelAndClose}>Cancel</Button>
            {advanced && (
              <Button variant="primary" type="submit" form={f('advanced')} disabled={!formValid && Object.keys(touched).length > 0}>Connect</Button>
            )}
          </div>
        </>
      )}

      {phase === 'sso-login' && (
        <div className="azure-center azure-msg">
          <div className="aws-step-label">AWS SSO Authorization</div>
          {device ? (
            <>
              <p>Open the link in your browser and make sure that the code matches, or enter the code below to authorize the application.</p>
              <div className="azure-code" aria-label={`Device code ${device.userCode}`}>{device.userCode}</div>
              {device.verificationUrl && <a className="ui-btn" data-variant="primary" data-size="md" href={device.verificationUrl} target="_blank" rel="noreferrer noopener"><Icon name="externalLink" size={14} /> <span className="ui-btn-label">Open in browser</span></a>}
              <div className="azure-waiting"><Loader label="Waiting for authorization…" /></div>
            </>
          ) : (
            <div className="azure-waiting"><Loader label="Starting AWS SSO sign-in…" /></div>
          )}
        </div>
      )}

      {phase === 'sso-account' && (
        <div className="aws-form">
          <div className="aws-step-label">Choose AWS account</div>
          {busy ? <div className="azure-center"><Loader label="Loading accounts…" /></div> : (
            ssoAccounts.length === 0 ? <div className="azure-empty">No accounts available for this SSO user.</div>
              : (
                <Field id={f('acct')} label="AWS account">
                  <select id={f('acct')} className="aws-input" value={chosenAccount} onChange={(e) => setChosenAccount(e.target.value)}>
                    {ssoAccounts.map((a) => <option key={a.accountId} value={a.accountId}>{a.accountName} ({a.accountId})</option>)}
                  </select>
                </Field>
              )
          )}
          <div className="action-modal-actions">
            <Button variant="secondary" onClick={cancelAndClose}>Cancel</Button>
            <Button variant="primary" disabled={!chosenAccount || busy} onClick={() => loadRoles(chosenAccount)}>Next</Button>
          </div>
        </div>
      )}

      {phase === 'sso-role' && (
        <div className="aws-form">
          <div className="aws-step-label">Choose AWS role for account</div>
          <div className="azure-dim">{ssoAccounts.find((a) => a.accountId === chosenAccount)?.accountName} ({chosenAccount})</div>
          {busy ? <div className="azure-center"><Loader label="Loading roles…" /></div> : (
            ssoRoles.length === 0 ? <div className="azure-empty">No roles available in this account.</div>
              : (
                <Field id={f('role')} label="Role">
                  <select id={f('role')} className="aws-input" value={chosenRole} onChange={(e) => setChosenRole(e.target.value)}>
                    {ssoRoles.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </Field>
              )
          )}
          <div className="action-modal-actions">
            <Button variant="secondary" onClick={() => setPhase('sso-account')}>Back</Button>
            <Button variant="primary" disabled={!chosenRole || busy} onClick={() => discoverSso(chosenAccount, chosenRole)}>Next</Button>
          </div>
        </div>
      )}

      {phase === 'listing' && <div className="azure-center"><Loader label="Discovering EKS clusters across all regions…" /></div>}

      {phase === 'list' && (
        <>
          <div className="azure-toolbar">
            <label htmlFor={f('filter')} className="sr-only">Filter clusters</label>
            <input id={f('filter')} type="search" className="azure-search" placeholder="Filter by name or region…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <span className="azure-count" aria-live="polite">{clusters.length} cluster{clusters.length === 1 ? '' : 's'} · {regionsScanned} region{regionsScanned === 1 ? '' : 's'}{activeProfile ? ` · ${activeProfile}` : ''}</span>
          </div>
          <div className="azure-list" role="group" aria-label="EKS clusters">
            {visible.length === 0 ? (
              <div className="azure-empty">{clusters.length === 0 ? 'No EKS clusters found for this account.' : 'No clusters match your filter.'}</div>
            ) : (
              <>
                <label className="azure-row azure-selall">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={selectable.length === 0} />
                  <span className="azure-selall-label">Select all</span>
                </label>
                {visible.map((c) => (
                  <label key={keyOf(c)} className={`azure-row ${c.imported ? 'imported' : ''}`}>
                    <input type="checkbox" checked={c.imported || sel.has(keyOf(c))} disabled={c.imported} onChange={() => toggle(c)} />
                    <span className="azure-cluster">
                      <span className="azure-cname">{c.name}</span>
                      <span className="azure-cmeta">{c.region}</span>
                    </span>
                    {c.imported && <span className="azure-badge added"><Icon name="check" size={12} strokeWidth={2.6} /> Added</span>}
                  </label>
                ))}
              </>
            )}
          </div>
          <div className="action-modal-actions">
            <Button variant="ghost" className="action-skip" onClick={skip} title="Continue without adding clusters">Skip</Button>
            <Button variant="secondary" onClick={cancelAndClose}>Cancel</Button>
            <Button variant="primary" disabled={sel.size === 0} onClick={doImport}>Add {sel.size} cluster{sel.size === 1 ? '' : 's'}</Button>
          </div>
        </>
      )}

      {phase === 'importing' && <div className="azure-center"><Loader label="Adding clusters to your kubeconfig…" /></div>}

      {phase === 'done' && (
        <div className="azure-center azure-msg" role="status">
          <div className="azure-done-icon"><Icon name="check" size={26} strokeWidth={2.6} /></div>
          <p><b>{result?.imported?.length || 0}</b> cluster{(result?.imported?.length || 0) === 1 ? '' : 's'} added to your kubeconfig.</p>
          {result?.failed?.length > 0 && <div className="azure-failed">{result.failed.map((fl) => <div key={fl.name}><b>{fl.name}</b>: {fl.error}</div>)}</div>}
          <p className="azure-dim">They're now available in the context selector.</p>
          <Button variant="primary" onClick={onClose}>Done</Button>
        </div>
      )}
    </Modal>
  );
}
