import { useId } from 'react';
import { toneColor, trackColor } from '../../lib/tokens';

/**
 * Single donut implementation for Overview / Cluster / Security.
 *
 * <Donut
 *   segments={[{ label: 'Running', value: 12, tone: 'ok' }, { label: 'Failed', value: 1, tone: 'bad', key: 'failed' }]}
 *   size={130} thickness={16}
 *   centerLabel="ready" centerValue="92%"
 *   ariaLabel="Pod status"
 *   legend            // render the legend list next to the ring
 *   onSegmentClick(key) activeKey
 * />
 * Segment colour: `tone` (preferred) or explicit `color`.
 */
export default function Donut({
  segments = [],
  size = 130,
  thickness = 16,
  centerLabel,
  centerValue,
  ariaLabel,
  legend = false,
  onSegmentClick,
  activeKey,
  className = '',
  emptyText = 'no data',
}) {
  const id = useId();
  const total = segments.reduce((n, s) => n + (s.value > 0 ? s.value : 0), 0);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const cx = size / 2;
  let acc = 0;
  const summary = segments.map((s) => `${s.label}: ${s.value}`).join(', ');
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;
  const color = (s) => s.color || toneColor(s.tone || 'muted');

  return (
    <div className={`ui-donut ${className}`.trim()} data-size={size}>
      <div className="ui-donut-ring" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-labelledby={titleId} aria-describedby={descId}>
          <title id={titleId}>{ariaLabel || 'Donut chart'}</title>
          <desc id={descId}>{total ? summary : 'No data'}</desc>
          <circle cx={cx} cy={cx} r={r} fill="none" stroke={trackColor()} strokeWidth={thickness} />
          {total > 0 && segments.filter((s) => s.value > 0).map((s, i) => {
            const frac = s.value / total;
            const dash = frac * c;
            const dim = activeKey && s.key && activeKey !== s.key;
            const clickable = !!(onSegmentClick && s.key);
            const el = (
              <circle
                key={s.key || s.label || i}
                cx={cx} cy={cx} r={r} fill="none"
                stroke={color(s)} strokeWidth={thickness}
                strokeDasharray={`${dash} ${c - dash}`}
                strokeDashoffset={-acc * c}
                transform={`rotate(-90 ${cx} ${cx})`}
                opacity={dim ? 0.28 : 1}
                style={clickable ? { cursor: 'pointer' } : undefined}
                onClick={clickable ? () => onSegmentClick(s.key) : undefined}
              >
                <title>{`${s.label}: ${s.value}`}</title>
              </circle>
            );
            acc += frac;
            return el;
          })}
          {total === 0 && !centerValue && <text x="50%" y="52%" textAnchor="middle" className="ui-donut-empty">{emptyText}</text>}
        </svg>
        {(centerValue != null || centerLabel) && (
          <div className="ui-donut-center" aria-hidden="true">
            {centerValue != null && <div className="ui-donut-num">{centerValue}</div>}
            {centerLabel && <div className="ui-donut-lbl">{centerLabel}</div>}
          </div>
        )}
      </div>
      {legend && (
        <ul className="ui-donut-legend">
          {segments.map((s) => {
            const clickable = !!(onSegmentClick && s.key);
            const active = activeKey && s.key === activeKey;
            const inner = (
              <>
                <i className="ui-donut-swatch" style={{ background: color(s) }} aria-hidden="true" />
                <span className="ui-donut-legend-label">{s.label}</span>
                <span className="ui-donut-legend-val">{s.value}</span>
              </>
            );
            return (
              <li key={s.key || s.label} className={`ui-donut-legend-item${active ? ' active' : ''}`}>
                {clickable
                  ? <button type="button" className="ui-donut-legend-btn" aria-pressed={!!active} onClick={() => onSegmentClick(s.key)}>{inner}</button>
                  : inner}
              </li>
            );
          })}
        </ul>
      )}
      <span className="sr-only">{ariaLabel ? `${ariaLabel}: ` : ''}{total ? summary : 'No data'}</span>
    </div>
  );
}

export { Donut };
