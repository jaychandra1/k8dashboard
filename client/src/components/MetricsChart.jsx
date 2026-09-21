import { useId } from 'react';
import { toneColor } from '../lib/tokens';

const W = 300;
const H = 68;
const PAD = 6;

// utilisation → tone: <80 ok, 80-90 warn, >=90 bad
const utilTone = (pct) => {
  if (pct == null) return null;
  if (pct >= 90) return 'bad';
  if (pct >= 80) return 'warn';
  return 'ok';
};

/**
 * Sparkline with an optional threshold line.
 * <MetricsChart id="cpu" label="CPU" data={[…millicores]} limit={500} thresholdLabel="limit" format={fmtCpu} tone="info" />
 * Colours come from the CSS tokens (`toneColor`), never hardcoded.
 */
export default function MetricsChart({ id, label, data, limit, format, tone = 'info', thresholdLabel = 'limit' }) {
  const rid = useId();
  const gradId = `grad-${id || rid}`;
  const titleId = `${rid}-title`;
  const points = data && data.length ? data : [0];
  const current = points[points.length - 1];
  const pct = limit ? (current / limit) * 100 : null;
  const color = toneColor(utilTone(pct) || tone);
  const limitColor = toneColor('bad');

  const dataMax = Math.max(...points, 0);
  const max = Math.max(dataMax, limit || 0, 1) * 1.15;
  const n = points.length;

  const yFor = (v) => H - PAD - (v / max) * (H - PAD * 2);
  const xy = points.map((v, i) => [n === 1 ? W : (i / (n - 1)) * W, yFor(v)]);
  const linePath = xy.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L ${W} ${H} L 0 ${H} Z`;
  const last = xy[xy.length - 1];
  const limitY = limit ? yFor(limit) : null;

  const fmt = format || ((v) => Math.round(v));
  const summary = `${label}: ${fmt(current)}${limit ? ` of ${fmt(limit)} ${thresholdLabel} (${Math.round(pct)}%)` : ''}${n > 1 ? `, ${n} samples` : ''}`;

  return (
    <div className="metric-chart">
      <div className="metric-chart-head">
        <span className="metric-chart-label">{label}</span>
        <span className="metric-chart-value" style={{ color }}>
          {fmt(current)}
          {limit ? (
            <span className="metric-chart-sub">
              {' / '}{fmt(limit)} {thresholdLabel}
              {pct != null && <span className="metric-chart-pct" style={{ color }}>{Math.round(pct)}%</span>}
            </span>
          ) : null}
        </span>
      </div>
      <svg className="metric-chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-labelledby={titleId} aria-label={summary}>
        <title id={titleId}>{summary}</title>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill={`url(#${gradId})`} />
        <path d={linePath} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
        {limitY != null && (
          <line x1="0" y1={limitY} x2={W} y2={limitY} stroke={limitColor} strokeWidth="1.2" strokeDasharray="5 4" vectorEffect="non-scaling-stroke" opacity="0.85" />
        )}
        {last && <circle cx={last[0]} cy={last[1]} r="2.8" fill={color} />}
      </svg>
      <span className="sr-only" aria-live="off">{summary}</span>
    </div>
  );
}
