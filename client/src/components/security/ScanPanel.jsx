import Icon from '../Icons';
import { formatAgeLong } from '../../lib/format';

// Built-in Trivy scan chrome: the one-time "preparing" screen, the progress /
// result banner (a live region), and the note shown on tabs that need the operator.

export function ScanProgress() {
  return (
    <div className="sec-setup" role="status" aria-live="polite">
      <div className="sec-setup-icon scanning" aria-hidden="true"><Icon name="shieldCheck" size={40} /></div>
      <h2>Preparing Trivy…</h2>
      <p>Downloading the Trivy scanner and its vulnerability database. This happens once — nothing is installed in your cluster. You can switch tabs or views; the scan runs in the background.</p>
    </div>
  );
}

export function ScanBanner({ scan, onRescan }) {
  const pct = scan.total ? Math.round((scan.scanned / scan.total) * 100) : 0;
  return (
    <div className="sec-banner" role="status" aria-live="polite">
      <Icon name="shieldCheck" size={15} className={scan.running ? 'sec-spin' : ''} />
      <span className="sec-banner-text">
        {scan.running ? `Scanning images… ${scan.scanned}/${scan.total || '…'}` : `Built-in Trivy scan · ${(scan.images || []).length} images`}
        {scan.finishedAt && !scan.running ? ` · ${scan.cached ? 'last scan ' : ''}${formatAgeLong(scan.finishedAt)}` : ''}
      </span>
      {scan.running && (
        <span className="sec-banner-progress" role="progressbar" aria-label="Scan progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <span className="sec-banner-progress-bar" style={{ width: `${pct}%` }} />
        </span>
      )}
      <button type="button" className="sec-banner-btn" onClick={onRescan} disabled={scan.running}>
        <Icon name="refresh" size={13} /> {scan.running ? `${pct}%` : 'Re-scan'}
      </button>
    </div>
  );
}

export function OperatorNote({ feature }) {
  return (
    <div className="sec-empty" role="status">
      <Icon name="shield" size={28} />
      <p><strong>{feature}</strong> needs the Trivy Operator.</p>
      <p className="sec-dim sec-note">The built-in scan covers image vulnerabilities. Install the Trivy Operator in-cluster to also get resource best-practice and RBAC checks.</p>
    </div>
  );
}

export default function ScanPanel({ scan, onRescan }) {
  if (!scan) return null;
  if (scan.phase === 'preparing') return <ScanProgress />;
  return <ScanBanner scan={scan} onRescan={onRescan} />;
}
