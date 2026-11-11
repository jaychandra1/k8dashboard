import { useEffect, useState } from 'react';
import Modal from './ui/Modal';
import Button from './ui/Button';
import Brand from './ui/Brand';

// Help → About K8Board (the desktop app's native menu sends
//   window.dispatchEvent(new CustomEvent('kubepilot:host', { detail: { type: 'show-about' } }))
// ), or the command palette's "About K8Board" (openAbout()).

const OPEN_EVENT = 'kubepilot:about';
/** Open the About dialog from inside the app. */
export const openAbout = () => window.dispatchEvent(new Event(OPEN_EVENT));

export const ABOUT_LINKS = [
  { label: 'Website', href: 'https://k8board.vercel.app' },
  { label: 'Privacy', href: 'https://k8board.vercel.app/privacy.html' },
  { label: 'Terms', href: 'https://k8board.vercel.app/terms.html' },
];

// External pages open in the system browser (the desktop host routes window.open there).
const openExternal = (e, href) => { e.preventDefault(); window.open(href, '_blank', 'noopener,noreferrer'); };

export default function AboutDialog() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const show = () => setOpen(true);
    const onHost = (e) => { if (e?.detail?.type === 'show-about') show(); };
    window.addEventListener('kubepilot:host', onHost);
    window.addEventListener(OPEN_EVENT, show);
    return () => {
      window.removeEventListener('kubepilot:host', onHost);
      window.removeEventListener(OPEN_EVENT, show);
    };
  }, []);

  if (!open) return null;
  const version = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '';
  // Only the desktop app updates itself (the Help menu's Check for Updates).
  const desktop = typeof window !== 'undefined' && !!window.k8boardHost;
  const close = () => setOpen(false);
  const checkUpdates = () => {
    close();
    window.dispatchEvent(new CustomEvent('kubepilot:host', { detail: { type: 'check-updates' } }));
  };

  return (
    <Modal
      open
      onClose={close}
      title="About K8Board"
      size="sm"
      className="about-modal"
      footer={(
        <>
          {desktop && <Button variant="secondary" icon="refresh" onClick={checkUpdates}>Check for Updates</Button>}
          <Button variant="primary" onClick={close}>Close</Button>
        </>
      )}
    >
      <div className="about">
        <img className="about-logo" src="/logo-mark.png" alt="" width="64" height="64" decoding="async" />
        <div className="about-name"><Brand /></div>
        {version && <div className="about-version">Version {version}</div>}
        <p className="about-tagline">Explore and operate your Kubernetes clusters, all in one window.</p>
        <nav className="about-links" aria-label="K8Board links">
          {ABOUT_LINKS.map((l) => (
            <a key={l.href} className="about-link" href={l.href} onClick={(e) => openExternal(e, l.href)} rel="noopener noreferrer">{l.label}</a>
          ))}
        </nav>
        <p className="about-legal">© 2026 JDG Initiates · MIT License<br />Figtree typeface · SIL Open Font License 1.1</p>
      </div>
    </Modal>
  );
}
