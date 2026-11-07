import { useMemo, useRef, useState } from 'react';
import Icon from './Icons';
import Button from './ui/Button';
import Badge from './ui/Badge';
import Menu from './ui/Menu';
import Tooltip from './ui/Tooltip';
import SearchBox from './ui/SearchBox';
import Brand from './ui/Brand';
import { PROVIDERS, providerKeyOf } from './ContextPickerModal';
import { formatAge } from '../lib/format';

// Home: where K8Board opens. It lists the clusters of the kubeconfig — read
// from the file only: nothing connects, signs in or calls a cluster API until
// the user clicks Connect — with the last connected one first, pinned ones
// next, and ways to add a cluster. The badges come from local files too
// (GET /api/config/status: AWS sign-in state from the token cache, production
// sign-ins). Also shown, inside the app, while connected (#/home).
//
//   <Home contexts contextsInfo lastConnected recent pins connected connecting
//         onConnect onOpenDashboard onDisconnect onTogglePin onRemove canRemove
//         onAddAws onAddAzure onAddLocal onOpenPreferences />

const SIGN_IN_BADGE = {
  expired: { tone: 'warn', text: 'AWS session expired' },
  'signed-out': { tone: 'warn', text: 'Signed out of AWS' },
};

/** Badges for a cluster, from local information only. */
export function clusterBadges(info) {
  const out = [];
  if (info?.signIn?.production) out.push({ tone: 'info', text: 'Production' });
  const s = SIGN_IN_BADGE[info?.signIn?.state];
  if (s) out.push(s);
  return out;
}

// A row's provider label (the picker's group headings read "Other clusters").
const ROW_LABEL = { other: 'Kubernetes' };

const lastUsedText = (at) => (Number.isFinite(at) ? `last used ${formatAge(new Date(at))} ago` : null);

/** Pinned first, then most recently used, then by name; filtered by `q`. */
export function orderClusters(contexts, { pins = [], recent = [], q = '' } = {}) {
  const used = new Map(recent.map((r, i) => [r.name, i]));
  const pinned = new Set(pins);
  const needle = q.trim().toLowerCase();
  return contexts
    .filter((c) => !needle || c.toLowerCase().includes(needle))
    .sort((a, b) => (Number(pinned.has(b)) - Number(pinned.has(a)))
      || ((used.has(a) ? used.get(a) : Infinity) - (used.has(b) ? used.get(b) : Infinity))
      || a.localeCompare(b));
}

function ConnectButton({ name, primary, connected, connecting, busy, onConnect, onOpenDashboard, size = 'sm' }) {
  if (connected) {
    return <Button size={size} variant="secondary" icon="arrowRight" onClick={onOpenDashboard} aria-label={`Open ${name}`}>Open</Button>;
  }
  return (
    <Button
      size={size}
      variant={primary ? 'primary' : 'secondary'}
      busy={busy}
      disabled={!!connecting && !busy}
      onClick={() => onConnect?.(name)}
      aria-label={`Connect to ${name}`}
    >
      {busy ? 'Connecting…' : 'Connect'}
    </Button>
  );
}

export default function Home({
  contexts = [], contextsInfo = [], lastConnected = null, recent = [], pins = [],
  connected = null, connecting = null,
  onConnect, onOpenDashboard, onDisconnect, onTogglePin, onRemove, canRemove,
  onAddAws, onAddAzure, onAddLocal, onOpenPreferences,
}) {
  const [q, setQ] = useState('');
  const [addMenu, setAddMenu] = useState(null);
  const addRef = useRef(null);

  const infoOf = useMemo(() => new Map(contextsInfo.map((c) => [c.name, c])), [contextsInfo]);
  const usedAt = useMemo(() => new Map(recent.map((r) => [r.name, r.at])), [recent]);
  const ordered = useMemo(() => orderClusters(contexts, { pins, recent, q }), [contexts, pins, recent, q]);
  const last = lastConnected && contexts.includes(lastConnected) ? lastConnected : null;
  const pinnedSet = useMemo(() => new Set(pins), [pins]);

  const addItems = [
    onAddAws && { key: 'aws', label: 'AWS EKS', icon: 'aws', onSelect: onAddAws },
    onAddAzure && { key: 'azure', label: 'Azure AKS', icon: 'azure', onSelect: onAddAzure },
    onAddLocal && { key: 'local', label: 'Kubeconfig file…', icon: 'box', onSelect: onAddLocal },
  ].filter(Boolean);
  const openAdd = () => {
    const r = addRef.current?.getBoundingClientRect?.();
    setAddMenu({ x: r ? r.right - 200 : 0, y: r ? r.bottom + 6 : 0 });
  };

  const provider = (name) => {
    const key = providerKeyOf(infoOf.get(name)?.provider);
    const p = PROVIDERS[key] || PROVIDERS.other;
    return ROW_LABEL[key] ? { ...p, label: ROW_LABEL[key] } : p;
  };
  const providerKey = (name) => providerKeyOf(infoOf.get(name)?.provider);

  return (
    <div className="home">
      <header className="home-head">
        <Brand className="home-brand" />
        <div className="home-head-actions">
          {addItems.length > 0 && (
            <span ref={addRef}>
              <Button variant="primary" size="sm" icon="plus" onClick={openAdd} aria-haspopup="menu" aria-expanded={!!addMenu}>Add cluster</Button>
            </span>
          )}
          {onOpenPreferences && (
            <Tooltip content="Preferences" placement="bottom">
              <Button variant="ghost" size="sm" icon="settings" iconOnly ariaLabel="Preferences" onClick={onOpenPreferences} />
            </Tooltip>
          )}
        </div>
        <Menu open={!!addMenu} x={addMenu?.x} y={addMenu?.y} minWidth={200} items={addItems} onClose={() => setAddMenu(null)} returnFocusTo={addRef.current?.querySelector('button')} ariaLabel="Add cluster" />
      </header>

      <main id="main" className="home-body" tabIndex={-1}>
        <div className="home-intro">
          <h1>{connected ? 'Clusters' : 'Welcome to K8Board'}</h1>
          <p>
            {connected
              ? <>Connected to <strong>{connected}</strong>. Connect to another cluster, or go back to it.</>
              : 'Pick a cluster to connect to. K8Board reads your kubeconfig; it contacts no cluster until you click Connect.'}
          </p>
          {connected && (
            <div className="home-intro-actions">
              <Button size="sm" variant="primary" icon="arrowRight" onClick={onOpenDashboard}>Open {connected}</Button>
              {onDisconnect && <Button size="sm" variant="secondary" icon="close" onClick={onDisconnect}>Disconnect</Button>}
            </div>
          )}
        </div>

        {last && !connected && (
          <section className="home-last" aria-label="Last connected">
            <span className="home-eyebrow">Last connected</span>
            <div className="home-last-body">
              <span className={`home-row-icon ctx-provider ctx-provider-${providerKey(last)}`} aria-hidden="true"><Icon name={provider(last).icon} size={22} /></span>
              <div className="home-row-main">
                <span className="home-last-name" title={last}>{last}</span>
                <span className="home-row-meta">{[provider(last).label, lastUsedText(usedAt.get(last))].filter(Boolean).join(' · ')}</span>
                {clusterBadges(infoOf.get(last)).length > 0 && (
                  <span className="home-row-badges">{clusterBadges(infoOf.get(last)).map((b) => <Badge key={b.text} tone={b.tone} size="sm">{b.text}</Badge>)}</span>
                )}
              </div>
              <ConnectButton name={last} primary size="md" connecting={connecting} busy={connecting?.context === last} onConnect={onConnect} />
            </div>
          </section>
        )}

        {contexts.length === 0 ? (
          <section className="home-empty" aria-label="No clusters">
            <Icon name="cluster" size={30} />
            <h2>No clusters yet</h2>
            <p>Add a cluster from your cloud account, or open a kubeconfig file. Nothing connects until you choose a cluster.</p>
            <div className="home-tiles">
              {addItems.map((it) => (
                <button key={it.key} type="button" className="home-tile" onClick={it.onSelect}>
                  <Icon name={it.icon} size={20} />
                  <span>{it.label}</span>
                </button>
              ))}
            </div>
          </section>
        ) : (
          <section className="home-list-card" aria-labelledby="home-clusters-h">
            <div className="home-list-head">
              <h2 id="home-clusters-h">Clusters <span className="home-count">{contexts.length}</span></h2>
              <SearchBox value={q} onChange={setQ} ariaLabel="Search clusters" placeholder="Search clusters…" width={240} />
            </div>
            {ordered.length === 0 ? (
              <p className="home-none">No cluster matches “{q}”.</p>
            ) : (
              <ul className="home-list" aria-label="Clusters in your kubeconfig">
                {ordered.map((name) => {
                  const pinned = pinnedSet.has(name);
                  const isConnected = connected === name;
                  const removable = onRemove && (!canRemove || canRemove(name));
                  const badges = clusterBadges(infoOf.get(name));
                  return (
                    <li key={name} className="home-row" data-connected={isConnected || undefined}>
                      <span className={`home-row-icon ctx-provider ctx-provider-${providerKey(name)}`} aria-hidden="true"><Icon name={provider(name).icon} size={18} /></span>
                      <div className="home-row-main">
                        <span className="home-row-name" title={name}>{name}</span>
                        <span className="home-row-meta">{[provider(name).label, lastUsedText(usedAt.get(name))].filter(Boolean).join(' · ')}</span>
                      </div>
                      <span className="home-row-badges">
                        {isConnected && <Badge tone="ok" size="sm">Connected</Badge>}
                        {badges.map((b) => <Badge key={b.text} tone={b.tone} size="sm">{b.text}</Badge>)}
                      </span>
                      <span className="home-row-actions">
                        {onTogglePin && (
                          <Tooltip content={pinned ? 'Unpin' : 'Pin'}>
                            <button type="button" className="home-icon-btn" data-on={pinned || undefined} aria-pressed={pinned} aria-label={`${pinned ? 'Unpin' : 'Pin'} ${name}`} onClick={() => onTogglePin(name)}>
                              <Icon name="pin" size={15} />
                            </button>
                          </Tooltip>
                        )}
                        {removable && (
                          <Tooltip content="Remove from kubeconfig…">
                            <button type="button" className="home-icon-btn home-icon-danger" aria-label={`Remove ${name}`} onClick={() => onRemove(name)}>
                              <Icon name="delete" size={15} />
                            </button>
                          </Tooltip>
                        )}
                        <ConnectButton
                          name={name}
                          primary={name === last && !connected}
                          connected={isConnected}
                          connecting={connecting}
                          busy={connecting?.context === name}
                          onConnect={onConnect}
                          onOpenDashboard={onOpenDashboard}
                        />
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
