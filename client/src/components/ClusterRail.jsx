import React, { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './Icons';
import Button from './ui/Button';
import Tooltip from './ui/Tooltip';
import useClickOutside from '../hooks/useClickOutside';

// A narrow far-left rail of pinned clusters (contexts) for quick switching.
// Pins are stored in localStorage; clicking one switches the active context.

const STORE_KEY = 'pinnedClusters';

const loadPins = () => {
  try { const v = JSON.parse(localStorage.getItem(STORE_KEY)); return Array.isArray(v) ? v : []; } catch { return []; }
};
const savePins = (pins) => { try { localStorage.setItem(STORE_KEY, JSON.stringify(pins)); } catch { /* ignore */ } };

// Deterministic hue from the context name, for the avatar colour (a CSS custom property, resolved in App.css).
const hueOf = (name) => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
};
const initials = (name) => {
  const parts = String(name).split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return String(name).replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
};

function ClusterRail({ contexts = [], currentContext, onSwitch }) {
  const [pins, setPins] = useState(loadPins);
  const [adding, setAdding] = useState(false);
  const addRef = useRef(null);
  const closeAdd = useCallback(() => setAdding(false), []);
  useClickOutside(addRef, closeAdd, adding);

  // Seed with the active context so the rail is never empty on first use.
  useEffect(() => {
    if (!currentContext) return;
    setPins((prev) => {
      if (prev.length) return prev;
      const next = [currentContext];
      savePins(next);
      return next;
    });
  }, [currentContext]);

  useEffect(() => {
    if (!adding) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setAdding(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [adding]);

  // Only show pins that still exist in the kubeconfig.
  const known = new Set(contexts);
  const visiblePins = pins.filter((pin) => known.has(pin) || pin === currentContext);
  const unpinned = contexts.filter((c) => !pins.includes(c));

  const update = (next) => { setPins(next); savePins(next); };
  const pin = (ctx) => { if (!pins.includes(ctx)) update([...pins, ctx]); setAdding(false); onSwitch(ctx); };
  const unpin = (ctx) => update(pins.filter((pin) => pin !== ctx));

  return (
    <aside className="cluster-rail" aria-label="Pinned clusters">
      <div className="cluster-rail-label" aria-hidden="true">PINS</div>

      <ul className="cluster-rail-pins">
        {visiblePins.map((ctx) => {
          const active = ctx === currentContext;
          return (
            <li key={ctx} className="cluster-pin-wrap">
              <Tooltip content={ctx} placement="right">
                <button
                  type="button"
                  className={`cluster-pin ${active ? 'active' : ''}`}
                  onClick={() => onSwitch(ctx)}
                  style={{ '--pin-hue': hueOf(ctx) }}
                  aria-label={active ? `${ctx} (current cluster)` : `Switch to ${ctx}`}
                  aria-current={active ? 'true' : undefined}
                >
                  <span className="cluster-pin-badge" aria-hidden="true">{initials(ctx)}</span>
                </button>
              </Tooltip>
              {!active && (
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon="close"
                  iconSize={10}
                  ariaLabel={`Unpin ${ctx}`}
                  className="cluster-pin-remove"
                  onClick={() => unpin(ctx)}
                />
              )}
            </li>
          );
        })}
      </ul>

      <div className="cluster-add-wrap" ref={addRef}>
        <Tooltip content="Pin a cluster" placement="right">
          <button type="button" className="cluster-add" onClick={() => setAdding((a) => !a)} aria-label="Pin a cluster" aria-haspopup="true" aria-expanded={adding}>
            <Icon name="plus" size={18} strokeWidth={2.2} />
          </button>
        </Tooltip>
        {adding && (
          <div className="cluster-add-menu" role="group" aria-label="Pin a cluster">
            <div className="cluster-add-title">Pin a cluster</div>
            {unpinned.length === 0 ? (
              <div className="cluster-add-empty">All contexts are pinned.</div>
            ) : (
              unpinned.map((ctx) => (
                <button key={ctx} type="button" className="cluster-add-option" onClick={() => pin(ctx)}>
                  <span className="cluster-add-dot" style={{ '--pin-hue': hueOf(ctx) }} aria-hidden="true">{initials(ctx)}</span>
                  <span className="cluster-add-name">{ctx}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

export default React.memo(ClusterRail);
