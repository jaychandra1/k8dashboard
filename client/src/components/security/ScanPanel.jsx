import Icon from '../Icons';
import { formatAgeLong } from '../../lib/format';
import { redactSensitive } from '../../lib/redact';
import { navToPods } from '../shared/nav';

// Built-in Trivy scan chrome: the one-time "preparing" screen, the progress /
// result banner (a live region), and the note shown on tabs that need the operator.
// Operator mode: OperatorBanner — what the Trivy Operator is doing right now.

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Trivy Operator scan progress (GET /api/security/progress): whether it runs,
 * scans in flight, how many running images have a report, the last report,
 * and — when scans stall or fail — why, with what to do about it. Failure
 * text is shown with environment identifiers masked.
 */
export function OperatorBanner({ progress, onRefresh, refreshing, onNavigate }) {
  if (!progress) return null;
  const op = progress.operator || {};
  const cov = progress.coverage;
  const failures = progress.failures || [];
  const hints = progress.hints || [];
  const pct = cov?.images ? Math.round((cov.scanned / cov.images) * 100) : 0;
  const allDone = cov && cov.images > 0 && cov.notScanned === 0;

  let tone = 'ok';
  let text;
  if (op.found && op.ready < 1) {
    tone = 'bad';
    text = `The Trivy Operator isn’t running (${op.ready}/${op.desired} ready) — no new scans will run until it is.`;
  } else if (progress.scanning) {
    text = `Trivy Operator is scanning · ${plural(progress.jobs.active, 'scan')} running${cov ? ` · ${cov.scanned} of ${plural(cov.images, 'image')} scanned` : ''}`;
  } else if (cov && cov.notScanned > 0) {
    tone = 'warn';
    text = `${cov.notScanned} of ${plural(cov.images, 'running image')} ${cov.notScanned === 1 ? 'isn’t' : 'aren’t'} scanned yet, and no scans are running${cov.failed ? ` (${cov.failed} failed)` : ''}`;
  } else if (allDone) {
    text = `All ${plural(cov.images, 'running image')} are scanned`;
  } else {
    text = op.found ? 'Trivy Operator is installed' : 'Showing the Trivy Operator’s reports';
  }
  const showWhy = tone !== 'ok' || failures.length > 0;

  return (
    <div className={`sec-banner sec-op-banner tone-${tone}`} role="status" aria-live="polite">
      <div className="sec-op-row">
        <Icon name={tone === 'ok' ? 'shieldCheck' : 'warning'} size={15} className={progress.scanning ? 'sec-spin' : ''} />
        <span className="sec-banner-text">
          {text}
          {progress.lastReportAt ? <span className="sec-dim"> · last report {formatAgeLong(progress.lastReportAt)}</span> : null}
          {op.found && op.concurrency && progress.scanning ? <span className="sec-dim"> · up to {op.concurrency} at a time</span> : null}
        </span>
        {cov && cov.images > 0 && !allDone && (
          <span className="sec-banner-progress" role="progressbar" aria-label="Images scanned" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <span className="sec-banner-progress-bar" style={{ width: `${pct}%` }} />
          </span>
        )}
        <button type="button" className="sec-banner-btn" onClick={onRefresh} disabled={refreshing}>
          <Icon name="refresh" size={13} className={refreshing ? 'sec-spin' : ''} /> Refresh
        </button>
      </div>
      {showWhy && (
        <div className="sec-op-why">
          {hints.map((h) => <p key={h.id} className="sec-op-hint"><strong>What to do:</strong> {h.text}</p>)}
          {failures.length > 0 && (
            <details open={hints.length === 0}>
              <summary>Recent scan errors ({failures.length})</summary>
              <ul className="sec-op-errors">{failures.map((f) => <li key={f}>{redactSensitive(f)}</li>)}</ul>
            </details>
          )}
          {tone !== 'ok' && failures.length === 0 && (
            <p className="sec-dim">No scan errors were found. The operator queues workloads and retries failed scans after a while; its pod logs show what it is doing.</p>
          )}
          {op.found && onNavigate && (
            <button type="button" className="sec-linkbtn" onClick={() => navToPods(onNavigate, op.namespace, op.name)}>Open the operator&apos;s pods ({op.namespace})</button>
          )}
        </div>
      )}
    </div>
  );
}

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
