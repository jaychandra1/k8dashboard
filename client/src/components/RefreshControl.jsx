import { useRef, useState } from 'react';
import Icon from './Icons';
import Menu from './ui/Menu';
import Tooltip from './ui/Tooltip';

// Auto-refresh cadences. `ms: 0` disables the timer. 'auto' is the default (1 min).
export const REFRESH_OPTIONS = [
  { key: 'auto', label: 'Auto', hint: '1 min', ms: 60000 },
  { key: '30s', label: '30 sec', ms: 30000 },
  { key: '1m', label: '1 min', ms: 60000 },
  { key: '5m', label: '5 min', ms: 300000 },
  { key: 'off', label: 'Off', ms: 0 },
];

export const refreshMs = (key) => REFRESH_OPTIONS.find((o) => o.key === key)?.ms || 0;

/**
 * Split refresh control: [refresh now | interval ▾]. Rendered in the TopBar
 * (pass `floating` to use the legacy fixed placement).
 */
export default function RefreshControl({ refreshing = false, onRefresh, refreshInterval = 'auto', onSetRefreshInterval, floating = false, row2 = false }) {
  const [menu, setMenu] = useState(null); // { x, y }
  const caretRef = useRef(null);

  const activeOpt = REFRESH_OPTIONS.find((o) => o.key === refreshInterval) || REFRESH_OPTIONS[0];
  const badgeLabel = activeOpt.key === 'off' ? 'Off'
    : activeOpt.key === 'auto' ? '1m'
      : activeOpt.label.replace(' sec', 's').replace(' min', 'm');
  const cadenceText = activeOpt.key === 'off' ? 'Auto-refresh: off' : `Auto-refresh every ${activeOpt.key === 'auto' ? '1 min' : activeOpt.label}`;

  const openMenu = () => {
    const r = caretRef.current?.getBoundingClientRect();
    setMenu({ x: r ? r.left : 0, y: r ? r.bottom + 4 : 0 });
  };

  const items = REFRESH_OPTIONS.map((o) => ({
    label: o.label,
    hint: o.hint,
    checked: refreshInterval === o.key,
    onSelect: () => onSetRefreshInterval?.(o.key),
  }));

  return (
    <div className={`refresh-control ${floating ? 'floating' : ''} ${row2 ? 'row2' : ''}`.trim()}>
      <Tooltip content="Refresh this page now">
        <button
          type="button"
          className={`refresh-toggle ${refreshing ? 'spinning' : ''}`}
          onClick={onRefresh}
          disabled={refreshing}
          aria-label={refreshing ? 'Refreshing' : 'Refresh now'}
          aria-busy={refreshing || undefined}
        >
          <Icon name="refresh" size={16} />
        </button>
      </Tooltip>
      <button
        ref={caretRef}
        type="button"
        className={`refresh-caret ${menu ? 'open' : ''} ${activeOpt.key !== 'off' ? 'on' : ''}`}
        onClick={() => (menu ? setMenu(null) : openMenu())}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        aria-label={`${cadenceText}. Change auto-refresh interval`}
      >
        <span className="refresh-badge" aria-hidden="true">{badgeLabel}</span>
        <Icon name="chevronDown" size={11} strokeWidth={2.4} />
      </button>
      {menu && (
        <Menu
          open
          x={menu.x}
          y={menu.y}
          items={items}
          ariaLabel="Auto-refresh interval"
          returnFocusTo={caretRef.current}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
