import { useCallback, useEffect, useRef, useState } from 'react';
import Modal from './ui/Modal';
import Button from './ui/Button';
import Loader from './Loader';
import { getJson, postJson, errorMessage } from '../lib/api';

import Brand from './ui/Brand';
// Help → Show Release Notes / Check for Updates (the desktop app's native Help
// menu, and Help → About K8Board). The Electron main process dispatches
//   window.dispatchEvent(new CustomEvent('kubepilot:host', { detail }))
// with detail = { type: 'show-release-notes' } | { type: 'check-updates' }.
// Everything else goes through the backend (/api/app/*, lib/updater/):
//   - the release notes are the ones shipped with the app;
//   - the update check asks the Microsoft Store (Windows), which is also who
//     installs the update. K8Board downloads and installs nothing itself, and
//     a copy with no store behind it has no update check.
// Nothing here names or links to where releases are hosted.

export const fmtDate = (iso) => {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  // A date without a time ("2026-11-11") is that calendar day in every time zone.
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    ...(dayOnly ? { timeZone: 'UTC' } : {}),
  });
};
const v = (version) => (version ? `v${String(version).replace(/^v/, '')}` : '');
// Windows: updates come from the Microsoft Store. K8Board's page there shows
// Update when a new version is out (the desktop host routes window.open to the
// system and allows exactly this non-web link; electron/main.cjs has the same address).
export const MS_STORE_URL = 'ms-windows-store://pdp/?productid=9N63V5DDVL9F';
const openStore = () => window.open(MS_STORE_URL, '_blank', 'noopener,noreferrer');

export default function UpdateDialogs() {
  const [notesOpen, setNotesOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);

  useEffect(() => {
    const onHost = (e) => {
      const type = e?.detail?.type;
      if (type === 'show-release-notes') setNotesOpen(true);
      else if (type === 'check-updates') setUpdateOpen(true);
    };
    window.addEventListener('kubepilot:host', onHost);
    return () => window.removeEventListener('kubepilot:host', onHost);
  }, []);

  return (
    <>
      <ReleaseNotesDialog open={notesOpen} onClose={() => setNotesOpen(false)} />
      <UpdateDialog open={updateOpen} onClose={() => setUpdateOpen(false)} />
    </>
  );
}

// ---- Release notes --------------------------------------------------------
// What's new in each version, newest first: the notes shipped with this copy
// (/api/app/release-notes reads release-notes.json). Nothing is fetched from
// the internet and nothing links out.
export function ReleaseNotesDialog({ open, onClose }) {
  const [st, setSt] = useState({ loading: false, notes: null, error: null });
  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    setSt({ loading: true, notes: null, error: null });
    try {
      const r = await getJson('/api/app/release-notes');
      if (n === seq.current) setSt({ loading: false, notes: r, error: null });
    } catch (err) {
      if (n === seq.current)
        setSt({
          loading: false,
          notes: null,
          error: errorMessage(err, 'K8Board could not load the release notes.'),
        });
    }
  }, []);
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const releases = Array.isArray(st.notes?.releases) ? st.notes.releases : [];
  const current = st.notes?.current;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={<><Brand /> Release Notes</>}
      icon="details"
      size="lg"
      className="release-notes-modal"
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          {st.error && (
            <Button variant="primary" icon="refresh" onClick={load}>
              Try Again
            </Button>
          )}
        </>
      }
    >
      {st.loading && <Loader inline label="Loading the release notes…" />}
      {st.error && (
        <div className="update-alert" role="alert">
          <b>Unable to load release notes</b>
          <p>{st.error}</p>
        </div>
      )}
      {st.notes && !releases.length && (
        <p className="update-muted">No release notes came with this version of <Brand />.</p>
      )}
      {releases.length > 0 && (
        <div className="release-notes-body">
          {current && !releases.some((r) => r.current) && (
            <p className="release-lead">
              You have version {current}. These are the notes of the versions before it.
            </p>
          )}
          {releases.map((r) => {
            const released = fmtDate(r.date);
            return (
              <section
                key={r.version}
                className={`release${r.current ? ' is-current' : ''}`}
                aria-label={`Version ${r.version}`}
              >
                <div className="release-meta">
                  <h3 className="release-version">Version {r.version}</h3>
                  {r.current && <span className="release-badge">This version</span>}
                  {released && <span className="release-date">{released}</span>}
                </div>
                <ul className="release-highlights">
                  {(r.highlights || []).map((h) => (
                    <li key={h.title}>
                      <span className="release-highlight-title">{h.title}</span>
                      {h.text && <span className="release-highlight-text">{h.text}</span>}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

// ---- Check for updates ----------------------------------------------------
// The backend's answer (POST /api/app/update/check → state.phase):
//   up-to-date / available   the Microsoft Store was asked (Windows);
//   store                    it couldn't be asked: its page has the answer;
//   unavailable              this copy has no store behind it, so no check.
// K8Board never downloads or installs an update: the Store does.
export function UpdateDialog({ open, onClose }) {
  const [s, setS] = useState(null);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  const seq = useRef(0);

  const check = useCallback(async () => {
    const n = ++seq.current;
    setError(null);
    setPending(true);
    // Keep who is being asked (the Microsoft Store on Windows) for the "Checking…" line.
    setS((prev) => ({ phase: 'checking', managedBy: prev?.managedBy }));
    try {
      const r = await postJson('/api/app/update/check', {});
      if (n === seq.current) setS(r.state);
    } catch (err) {
      if (n === seq.current) setError(errorMessage(err, 'K8Board could not check for updates.'));
    } finally {
      if (n === seq.current) setPending(false);
    }
  }, []);

  // On open: learn who delivers this copy's updates, then check.
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    setError(null);
    setS({ phase: 'checking' });
    (async () => {
      try {
        const r = await getJson('/api/app/update');
        if (live) setS({ phase: 'checking', managedBy: r?.state?.managedBy });
      } catch {
        /* the check below reports what is wrong */
      }
      if (live) check();
    })();
    return () => {
      live = false;
    };
  }, [open, check]);

  const phase = s?.phase;
  const current = s?.currentVersion;
  const latest = s?.latest;
  // Windows: the Microsoft Store is who gets asked, and who installs the update.
  const fromStore = s?.managedBy === 'store';
  const storeButton = (
    <Button variant="primary" icon="externalLink" onClick={openStore}>
      Open Microsoft Store
    </Button>
  );

  let title = 'Check for Updates';
  let icon = 'refresh';
  let body = <Loader inline label={fromStore ? 'Checking the Microsoft Store…' : 'Checking for updates…'} />;
  let footer = <Button onClick={onClose}>Cancel</Button>;

  if (error) {
    title = 'Unable to check for updates';
    icon = 'warning';
    body = (
      <div className="update-alert" role="alert">
        <p>{error}</p>
      </div>
    );
    footer = (
      <>
        <Button onClick={onClose}>Close</Button>
        <Button variant="primary" icon="refresh" busy={pending} onClick={check}>
          Try Again
        </Button>
      </>
    );
  } else if (phase === 'store') {
    // The Store couldn't be asked for its version: its page has the answer.
    title = 'Updates come from the Microsoft Store';
    icon = 'download';
    body = (
      <>
        <p className="update-text">
          You have <Brand /> <b>{v(current)}</b>. The Microsoft Store installs new versions automatically.
        </p>
        <p className="update-note" role="note">
          To check now, open <Brand /> in the Store: it shows <b>Update</b> when a new version is out.
        </p>
      </>
    );
    footer = (
      <>
        <Button onClick={onClose}>Close</Button>
        {storeButton}
      </>
    );
  } else if (phase === 'up-to-date') {
    title = <><Brand /> is up to date</>;
    icon = 'check';
    body = (
      <>
        <p className="update-text">
          You are running the latest version: <b>{v(current)}</b>
        </p>
        {fromStore && <p className="update-muted">Checked with the Microsoft Store.</p>}
      </>
    );
    footer = (
      <Button variant="primary" onClick={onClose}>
        OK
      </Button>
    );
  } else if (phase === 'available') {
    title = <><Brand /> Update Available</>;
    icon = 'download';
    body = (
      <>
        <p className="update-text">A new version of <Brand /> is available in the Microsoft Store.</p>
        <dl className="update-versions">
          <dt>Installed version</dt>
          <dd>{v(current)}</dd>
          <dt>Microsoft Store version</dt>
          <dd>{v(latest?.version)}</dd>
        </dl>
        <p className="update-note" role="note">
          The Microsoft Store installs it automatically. To get it now, open <Brand /> in the Store and
          choose <b>Update</b>.
        </p>
      </>
    );
    footer = (
      <>
        <Button onClick={onClose}>Close</Button>
        {storeButton}
      </>
    );
  } else if (phase === 'unavailable') {
    // No store delivers this copy, so there is nobody to ask.
    title = 'Check for Updates';
    icon = 'details';
    body = (
      <>
        <p className="update-text">
          You have <Brand /> <b>{v(current)}</b>.
        </p>
        <p className="update-note" role="note">
          This copy of <Brand /> doesn&apos;t check for updates. To update it, install a newer version the
          way you installed this one.
        </p>
      </>
    );
    footer = (
      <Button variant="primary" onClick={onClose}>
        OK
      </Button>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      icon={icon}
      size="sm"
      className="update-modal"
      footer={footer}
    >
      {body}
    </Modal>
  );
}
