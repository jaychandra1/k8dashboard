import React, { useEffect, useState } from 'react';
import Icon from './Icons';
import RefreshControl from './RefreshControl';
import Tooltip from './ui/Tooltip';
import { getAiConfig, isExternalAgent, aiToolName, aiToolIcon } from '../aiConfig';
import { MOD } from './shell/ShortcutsSheet';

// Native-style global top toolbar. Spans the full window width, doubles as the
// window drag region (macOS traffic lights sit at its left), and holds the
// nav toggle (narrow layouts), the `lead` slot (App passes the cluster switcher
// + back/forward arrows), then the ⌘K hint, the AI launcher, notifications and
// the refresh control on the right.
function TopBar({
  lead,
  onNotifications, onConfigureAi,
  onRefresh, refreshing, refreshInterval, onSetRefreshInterval,
  onOpenPalette,
  navOpen = false, onToggleNav, navToggleRef,
}) {
  const [cfg, setCfg] = useState(getAiConfig);
  useEffect(() => {
    const onChange = () => setCfg(getAiConfig());
    window.addEventListener('aiconfig:change', onChange);
    return () => window.removeEventListener('aiconfig:change', onChange);
  }, []);

  const launchAi = () => {
    if (isExternalAgent(cfg)) {
      window.dispatchEvent(new CustomEvent('agent:open', { detail: { agentId: cfg.id, agentName: cfg.name } }));
    } else if (cfg.mode === 'none') {
      onConfigureAi?.();
    } else {
      window.dispatchEvent(new CustomEvent('assistant:open'));
    }
  };
  const aiTitle = isExternalAgent(cfg) ? `Open ${aiToolName(cfg)}` : cfg.mode === 'none' ? 'Configure AI tool' : 'Open AI chat';
  // Show the chosen tool's own icon + name (compact label for the built-in/none modes).
  const aiLabel = cfg.mode === 'builtin' ? 'AI' : cfg.mode === 'none' ? 'No AI' : aiToolName(cfg);

  return (
    <header className="topbar">
      <button
        ref={navToggleRef}
        type="button"
        className="nav-toggle"
        aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
        aria-expanded={navOpen}
        aria-controls="primary-nav"
        onClick={onToggleNav}
      >
        <Icon name="apps" size={17} />
      </button>
      {lead && <div className="topbar-lead">{lead}</div>}
      <div className="topbar-spacer" />
      <div className="topbar-actions">
        <button type="button" className="topbar-kbd" onClick={onOpenPalette} aria-label={`Open command palette (${MOD} K)`}>
          <Icon name="search" size={13} />
          <kbd aria-hidden="true">{MOD} K</kbd>
        </button>
        <div className="topbar-ai">
          <button type="button" className="topbar-ai-main" onClick={launchAi} aria-label={aiTitle}>
            <Icon name={aiToolIcon(cfg)} size={15} /> <span>{aiLabel}</span>
          </button>
          <Tooltip content="AI settings">
            <button type="button" className="topbar-ai-caret" onClick={onConfigureAi} aria-label="AI settings">
              <Icon name="chevronDown" size={13} />
            </button>
          </Tooltip>
        </div>
        <Tooltip content="Events & alerts">
          <button type="button" className="topbar-btn" onClick={onNotifications} aria-label="Events and alerts">
            <Icon name="bell" size={17} />
          </button>
        </Tooltip>
        {onRefresh && (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            refreshInterval={refreshInterval}
            onSetRefreshInterval={onSetRefreshInterval}
          />
        )}
      </div>
    </header>
  );
}

export default React.memo(TopBar);
