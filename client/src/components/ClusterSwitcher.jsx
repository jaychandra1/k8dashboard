import React from 'react';
import Icon from './Icons';
import Tooltip from './ui/Tooltip';
import { PROVIDERS, providerKeyOf } from './ContextPickerModal';

// Cluster switcher — the button at the left end of the top bar, filling the
// column above the sidebar. It shows the connected cluster (provider icon +
// name, ellipsised) and opens the "Switch cluster" window (ContextPickerModal):
// one searchable list that reads the same with 4 clusters or 40, where a
// cluster can also be added, removed, or disconnected from.
//
// It is a button, not a menu: a menu listing every context grows with the
// kubeconfig and has to be scrolled.
//
//   <ClusterSwitcher contextsInfo currentContext open onOpen />
function ClusterSwitcher({ contextsInfo, currentContext, open = false, onOpen }) {
  const info = (contextsInfo || []).find((c) => c.name === currentContext);
  const key = info ? providerKeyOf(info.provider) : 'other';
  const provider = PROVIDERS[key] || PROVIDERS.other;
  // Long names ellipsise, so the tooltip carries the full name.
  const tip = currentContext ? `Switch cluster · ${currentContext}` : 'Switch cluster';

  return (
    <div className="cluster-switcher">
      <Tooltip content={tip} placement="bottom">
        <button
          type="button"
          className="cluster-switcher-btn"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`Switch cluster (current: ${currentContext || 'none'})`}
          onClick={() => onOpen?.()}
          onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); onOpen?.(); } }}
        >
          <Icon name={provider.icon} size={15} className={`ctx-provider ctx-provider-${key}`} />
          <span className="cluster-switcher-name">{currentContext || 'No cluster'}</span>
          <Icon name="chevronDown" size={12} strokeWidth={2.2} className="cluster-switcher-caret" />
        </button>
      </Tooltip>
    </div>
  );
}

export default React.memo(ClusterSwitcher);
