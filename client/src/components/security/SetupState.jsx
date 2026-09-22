import Icon from '../Icons';

/** No operator and no scan yet: run the built-in scan or install the Trivy Operator. */
export default function SetupState({ error, scanAvail, onScan, scanError, starting }) {
  const canScan = !!(scanAvail?.available || scanAvail?.installable);
  return (
    <div className="sec-view">
      <div className="sec-head"><div className="sec-title"><Icon name="shield" size={20} /> <h1>Security</h1></div></div>
      <div className="sec-setup">
        <div className="sec-setup-icon" aria-hidden="true"><Icon name="shield" size={40} /></div>
        <h2>Scan your cluster for vulnerabilities</h2>
        {canScan ? (
          <>
            <p>
              Run a <strong>built-in image scan</strong> right now — k8dashboard scans every image your cluster is running with Trivy{scanAvail.version ? ` (${scanAvail.version})` : ''}. <strong>Nothing to install in your cluster.</strong>
              {!scanAvail.available ? ' The first run downloads the Trivy binary (~60 MB) and its vulnerability database, so it may take a few minutes.' : ' The first scan downloads Trivy\'s vulnerability database and may take a few minutes.'}
            </p>
            <button type="button" className="sec-run-btn" onClick={onScan} disabled={starting} aria-busy={starting || undefined}>
              <Icon name="shieldCheck" size={16} /> {starting ? 'Starting…' : scanAvail.available ? 'Run built-in scan' : 'Download Trivy & scan'}
            </button>
            {scanError && <div className="sec-scan-error" role="alert">{scanError}</div>}
            <p className="sec-dim sec-setup-more">For continuous scanning plus resource best-practice and RBAC checks, install the Trivy Operator in-cluster (below).</p>
          </>
        ) : (
          <p>The Security Center reads image-CVE, best-practice and RBAC reports from the <strong>Trivy Operator</strong> in your cluster. Install the operator once and its scans light up this view automatically.</p>
        )}
        <div className="sec-setup-cmd">
          <pre><code>helm repo add aqua https://aquasecurity.github.io/helm-charts/
helm install trivy-operator aqua/trivy-operator \
  --namespace trivy-system --create-namespace</code></pre>
        </div>
        <a className="sec-link" href="https://aquasecurity.github.io/trivy-operator/latest/getting-started/installation/helm/" target="_blank" rel="noreferrer">
          Trivy Operator install guide <Icon name="externalLink" size={12} /><span className="sr-only"> (opens in a new tab)</span>
        </a>
        {error && <div className="sec-dim sec-setup-note">Note: {error}</div>}
      </div>
    </div>
  );
}

export { SetupState };
