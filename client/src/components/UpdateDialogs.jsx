import { useCallback, useEffect, useRef, useState } from 'react';
import Modal from './ui/Modal';
import Button from './ui/Button';
import Loader from './Loader';
import Markdown from './Markdown';
import { useToast } from './Toast';
import { getJson, postJson, errorMessage } from '../lib/api';

// Help → Show Release Notes / Check for Updates (the desktop app's native Help
// menu). The Electron main process dispatches
//   window.dispatchEvent(new CustomEvent('kubepilot:host', { detail }))
// with detail = { type: 'show-release-notes' } | { type: 'check-updates' }
//             | { type: 'update-result', status: 'installed' | 'failed', version, from }.
// Everything else goes through the backend (/api/app/*, lib/updater/): it reads
// GitHub Releases, downloads and verifies the installer, and asks the desktop
// host to install it and restart.

const POLL_MS = 400;
const BUSY = new Set(['checking', 'downloading', 'verifying', 'installing']);
// Phases where closing the dialog mustn't look like cancelling.
const LOCKED = new Set(['downloading', 'verifying', 'installing', 'restarting']);

export const fmtBytes = (n) => {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};
export const fmtDate = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    : null;
};
const v = (version) => (version ? `v${String(version).replace(/^v/, '')}` : '');
// External pages open in the system browser (the desktop host routes window.open there).
const openExternal = (url) => {
  if (/^https:\/\//.test(url || '')) window.open(url, '_blank', 'noopener,noreferrer');
};

export default function UpdateDialogs() {
  const toast = useToast();
  const [notesOpen, setNotesOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    const onHost = (e) => {
      const d = e?.detail || {};
      if (d.type === 'show-release-notes') setNotesOpen(true);
      else if (d.type === 'check-updates') setUpdateOpen(true);
      else if (d.type === 'update-result') {
        if (d.status === 'installed')
          toast.success(`KubePilot was updated to ${v(d.version)}.`, { title: 'Update installed' });
        else if (d.status === 'failed') setResult(d);
      }
    };
    window.addEventListener('kubepilot:host', onHost);
    return () => window.removeEventListener('kubepilot:host', onHost);
  }, [toast]);

  return (
    <>
      <ReleaseNotesDialog open={notesOpen} onClose={() => setNotesOpen(false)} />
      <UpdateDialog
        open={updateOpen}
        onClose={() => setUpdateOpen(false)}
        onShowNotes={() => setNotesOpen(true)}
      />
      <Modal
        open={!!result}
        onClose={() => setResult(null)}
        title="Update failed"
        icon="warning"
        danger
        size="sm"
        footer={
          <>
            <Button onClick={() => setResult(null)}>Close</Button>
            <Button
              variant="primary"
              icon="refresh"
              onClick={() => {
                setResult(null);
                setUpdateOpen(true);
              }}
            >
              Try Again
            </Button>
          </>
        }
      >
        <p className="update-text">
          The update to KubePilot {v(result?.version)} did not complete. Your existing KubePilot installation
          {result?.from ? ` (${v(result.from)})` : ''} has not been modified.
        </p>
      </Modal>
    </>
  );
}

// ---- Release notes --------------------------------------------------------
export function ReleaseNotesDialog({ open, onClose }) {
  const [st, setSt] = useState({ loading: false, release: null, error: null });
  const seq = useRef(0);
  const load = useCallback(async (fresh) => {
    const n = ++seq.current;
    setSt({ loading: true, release: null, error: null });
    try {
      const r = await getJson('/api/app/release-notes', { params: fresh ? { fresh: '1' } : undefined });
      if (n === seq.current) setSt({ loading: false, release: r.release, error: null });
    } catch (err) {
      if (n === seq.current)
        setSt({
          loading: false,
          release: null,
          error: errorMessage(err, 'KubePilot could not load the release notes.'),
        });
    }
  }, []);
  useEffect(() => {
    if (open) load(false);
  }, [open, load]);

  const r = st.release;
  const released = fmtDate(r?.publishedAt);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="KubePilot Release Notes"
      icon="details"
      size="lg"
      className="release-notes-modal"
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          {st.error && (
            <Button variant="primary" icon="refresh" onClick={() => load(true)}>
              Try Again
            </Button>
          )}
          {r?.htmlUrl && (
            <Button variant="primary" icon="externalLink" onClick={() => openExternal(r.htmlUrl)}>
              View on GitHub
            </Button>
          )}
        </>
      }
    >
      {st.loading && <Loader inline label="Loading the latest release notes…" />}
      {st.error && (
        <div className="update-alert" role="alert">
          <b>Unable to load release notes</b>
          <p>{st.error}</p>
        </div>
      )}
      {r && (
        <>
          <div className="release-meta">
            <span className="release-version">Version {r.version}</span>
            {released && <span className="release-date">Released: {released}</span>}
          </div>
          <div className="release-notes-body">
            {r.body ? (
              <Markdown text={r.body} />
            ) : (
              <p className="update-muted">No release notes were published for this version.</p>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

// ---- Check for updates ----------------------------------------------------
function failureView(err) {
  const code = err?.code;
  const stage = err?.stage;
  if (code === 'no_asset_for_os' || code === 'no_asset_for_arch')
    return { title: 'No compatible installer', action: 'release' };
  if (code === 'verification_failed' || code === 'verification_unavailable')
    return { title: 'Update verification failed', action: null };
  if (code === 'unsupported') return { title: "KubePilot can't install this update", action: 'release' };
  if (stage === 'check' || !stage) return { title: 'Unable to check for updates', action: 'check' };
  if (stage === 'download') return { title: 'Download failed', action: 'download' };
  if (stage === 'restart') return { title: 'Restart failed', action: null };
  return { title: 'Update failed', action: 'download' };
}

export function UpdateDialog({ open, onClose, onShowNotes }) {
  const toast = useToast();
  const [s, setS] = useState(null);
  const [reqError, setReqError] = useState(null);
  const [pending, setPending] = useState(false);

  const call = useCallback(async (method, url, body) => {
    setPending(true);
    try {
      const r = method === 'get' ? await getJson(url) : await postJson(url, body || {});
      setS(r.state);
      setReqError(null);
      return r.state;
    } catch (err) {
      setReqError({
        code: err?.code || 'error',
        message: errorMessage(err, 'KubePilot could not reach its update service.'),
      });
      return null;
    } finally {
      setPending(false);
    }
  }, []);

  const check = useCallback(() => {
    setS({ phase: 'checking' });
    return call('post', '/api/app/update/check');
  }, [call]);

  // On open: resume a download / install already in progress, else check now.
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    setReqError(null);
    setS({ phase: 'checking' });
    (async () => {
      const cur = await call('get', '/api/app/update');
      if (!live) return;
      if (
        !cur ||
        !['downloading', 'verifying', 'installing', 'ready', 'installed', 'scheduled'].includes(cur.phase)
      )
        await check();
    })();
    return () => {
      live = false;
    };
  }, [open, call, check]);

  // Poll while the backend is working.
  const phase = s?.phase;
  useEffect(() => {
    if (!open || !BUSY.has(phase) || phase === 'checking') return undefined;
    const t = setInterval(() => {
      getJson('/api/app/update')
        .then((r) => setS(r.state))
        .catch(() => {});
    }, POLL_MS);
    return () => clearInterval(t);
  }, [open, phase]);

  // A cancelled download closes the dialog.
  useEffect(() => {
    if (open && phase === 'cancelled') {
      toast.info('The update download was cancelled.');
      onClose();
    }
  }, [open, phase, toast, onClose]);

  const latest = s?.latest;
  const current = s?.currentVersion;
  const releaseUrl = latest?.htmlUrl;
  const locked = LOCKED.has(phase) && !s?.dryRun;
  const err = reqError ? { ...reqError, stage: 'check' } : phase === 'failed' ? s.error : null;

  let title = 'Check for Updates';
  let icon = 'refresh';
  let body = <Loader inline label="Checking for updates…" />;
  let footer = <Button onClick={onClose}>Cancel</Button>;

  if (err) {
    const view = failureView(err);
    title = view.title;
    icon = 'warning';
    body = (
      <div className="update-alert" role="alert">
        <p>{err.message}</p>
        {(err.code === 'install_failed' || err.code === 'installer_launch_failed') && (
          <p className="update-muted">Your existing KubePilot installation has not been modified.</p>
        )}
      </div>
    );
    footer = (
      <>
        <Button onClick={onClose}>Close</Button>
        {view.action === 'check' && (
          <Button variant="primary" icon="refresh" busy={pending} onClick={check}>
            Try Again
          </Button>
        )}
        {view.action === 'download' && (
          <Button
            variant="primary"
            icon="refresh"
            busy={pending}
            onClick={() => call('post', '/api/app/update/download')}
          >
            Try Again
          </Button>
        )}
        {view.action === 'release' && releaseUrl && (
          <Button variant="primary" icon="externalLink" onClick={() => openExternal(releaseUrl)}>
            View Release
          </Button>
        )}
      </>
    );
  } else if (phase === 'up-to-date') {
    title = 'KubePilot is up to date';
    icon = 'check';
    body = (
      <p className="update-text">
        You are running the latest version: <b>{v(current)}</b>
      </p>
    );
    footer = (
      <Button variant="primary" onClick={onClose}>
        OK
      </Button>
    );
  } else if (phase === 'available') {
    title = 'KubePilot Update Available';
    icon = 'download';
    const released = fmtDate(latest?.publishedAt);
    body = (
      <>
        <p className="update-text">A new version of KubePilot is available.</p>
        <dl className="update-versions">
          <dt>Installed version</dt>
          <dd>{v(current)}</dd>
          <dt>Latest version</dt>
          <dd>
            {v(latest?.version)}
            {released ? <span className="update-muted"> · {released}</span> : null}
          </dd>
        </dl>
        {onShowNotes && (
          <button type="button" className="link-btn update-notes-link" onClick={onShowNotes}>
            What&apos;s new in {v(latest?.version)}
          </button>
        )}
        {!s.canInstall && (
          <p className="update-note" role="note">
            {s.installUnavailable} You can download the installer from the release page.
          </p>
        )}
      </>
    );
    footer = s.canInstall ? (
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          icon="download"
          busy={pending}
          onClick={() => call('post', '/api/app/update/download')}
        >
          Download and Install
        </Button>
      </>
    ) : (
      <>
        <Button onClick={onClose}>Close</Button>
        {releaseUrl && (
          <Button variant="primary" icon="externalLink" onClick={() => openExternal(releaseUrl)}>
            View Release
          </Button>
        )}
      </>
    );
  } else if (phase === 'downloading' || phase === 'verifying' || phase === 'installing') {
    title = 'Updating KubePilot';
    icon = 'download';
    const total = s.progress?.total || s.asset?.size || 0;
    const received = s.progress?.received || 0;
    const pct = phase === 'downloading' && total ? Math.min(100, Math.floor((received / total) * 100)) : null;
    const label =
      phase === 'downloading'
        ? `Downloading KubePilot ${v(latest?.version)}…`
        : phase === 'verifying'
          ? 'Verifying update…'
          : 'Installing update…';
    body = (
      <div className="update-progress-wrap">
        <p className="update-text" aria-live="polite">
          {label}
        </p>
        <div
          className={`update-progress${pct === null ? ' indeterminate' : ''}`}
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct ?? undefined}
        >
          <div className="update-progress-bar" style={pct === null ? undefined : { width: `${pct}%` }} />
        </div>
        <div className="update-progress-meta">
          {phase === 'downloading' ? (
            <>
              <span>{pct ?? 0}%</span>
              <span>
                {fmtBytes(received)} / {total ? fmtBytes(total) : '…'}
              </span>
            </>
          ) : (
            <span>
              {phase === 'verifying'
                ? 'Checking the SHA-256 published with the release'
                : 'This can take a minute'}
            </span>
          )}
        </div>
      </div>
    );
    footer =
      phase === 'installing' ? (
        <Button disabled>Installing…</Button>
      ) : (
        <Button onClick={() => call('post', '/api/app/update/cancel')}>Cancel</Button>
      );
  } else if (phase === 'ready') {
    title = 'Ready to Install';
    icon = 'download';
    body = (
      <>
        <p className="update-text">KubePilot {v(latest?.version)} has been downloaded and verified.</p>
        <p className="update-text">
          To install it, KubePilot closes, installs the update and opens again automatically. Choose{' '}
          <b>Later</b> to install it the next time you quit KubePilot.
        </p>
      </>
    );
    footer = (
      <>
        <Button
          busy={pending}
          onClick={async () => {
            const st = await call('post', '/api/app/update/install', { when: 'on-quit' });
            if (st?.phase === 'scheduled') {
              toast.info(`KubePilot ${v(latest?.version)} will be installed when you quit KubePilot.`);
              onClose();
            }
          }}
        >
          Later
        </Button>
        <Button
          variant="primary"
          icon="refresh"
          busy={pending}
          onClick={() => call('post', '/api/app/update/install', { when: 'now' })}
        >
          Install and Restart
        </Button>
      </>
    );
  } else if (phase === 'scheduled') {
    title = 'Update Scheduled';
    icon = 'check';
    body = (
      <p className="update-text">
        KubePilot {v(latest?.version)} will be installed the next time you quit KubePilot.
      </p>
    );
    footer = (
      <Button variant="primary" onClick={onClose}>
        OK
      </Button>
    );
  } else if (phase === 'installed') {
    title = 'Update Installed';
    icon = 'check';
    body = (
      <>
        <p className="update-text">KubePilot {v(latest?.version)} has been installed successfully.</p>
        <p className="update-text">Restart KubePilot to complete the update.</p>
        {s.dryRun && (
          <p className="update-note" role="note">
            Dry run: nothing was actually installed.
          </p>
        )}
      </>
    );
    footer = (
      <>
        <Button onClick={onClose}>Later</Button>
        <Button
          variant="primary"
          icon="refresh"
          busy={pending}
          onClick={() => call('post', '/api/app/update/restart')}
        >
          Restart Now
        </Button>
      </>
    );
  } else if (phase === 'restarting') {
    title = s.dryRun ? 'Dry run complete' : 'Restarting KubePilot';
    icon = 'refresh';
    body = s.dryRun ? (
      <p className="update-text">
        Dry run: KubePilot {v(latest?.version)} was verified, but nothing was installed and KubePilot will not
        restart.
      </p>
    ) : (
      <Loader
        inline
        label={
          s.installMode === 'on-restart'
            ? 'KubePilot is closing to install the update and will open again automatically…'
            : 'Restarting KubePilot…'
        }
      />
    );
    footer = s.dryRun ? (
      <Button variant="primary" onClick={onClose}>
        OK
      </Button>
    ) : null;
  }

  return (
    <Modal
      open={open}
      onClose={locked ? () => {} : onClose}
      title={title}
      icon={icon}
      size="sm"
      className="update-modal"
      closeOnBackdrop={!locked}
      closeOnEscape={!locked}
      showClose={!locked}
      footer={footer}
    >
      {body}
    </Modal>
  );
}
