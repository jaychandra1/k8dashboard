// Trivy severities → tones / colours. Pills and mini counts are styled purely
// through `data-sev` in App.css (the --sev custom property); the Donut needs a
// resolved colour, which comes from the theme tokens at render time.
import { toneColor } from '../../lib/tokens';

export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];

export const sevLabel = (k) => (k ? k[0] + k.slice(1).toLowerCase() : '');
export const sevTotal = (s = {}) => SEVERITIES.reduce((n, k) => n + (s[k] || 0), 0);
export const worstSeverity = (summary = {}) => SEVERITIES.find((k) => summary[k]) || 'LOW';

const hexToRgb = (hex) => {
  const m = String(hex).trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const mixHex = (a, b, t = 0.5) => {
  const ra = hexToRgb(a); const rb = hexToRgb(b);
  if (!ra || !rb) return a;
  const c = ra.map((v, i) => Math.round(v + (rb[i] - v) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
};

/** Resolved colour for a severity (CRITICAL red, HIGH orange = red↔yellow, MEDIUM yellow, LOW blue, UNKNOWN muted). */
export function sevColor(k) {
  switch (k) {
    case 'CRITICAL': return toneColor('bad');
    case 'HIGH': return mixHex(toneColor('bad'), toneColor('warn'), 0.5);
    case 'MEDIUM': return toneColor('warn');
    case 'LOW': return toneColor('info');
    default: return toneColor('muted');
  }
}

/** Donut segments for a severity summary (UNKNOWN omitted, like the Trivy UI). */
export const sevSegments = (summary = {}) => SEVERITIES.filter((k) => k !== 'UNKNOWN')
  .map((k) => ({ key: k, label: sevLabel(k), value: summary[k] || 0, color: sevColor(k) }));

export function SevPill({ s }) {
  return <span className="sec-pill sec-sev" data-sev={s}>{s}</span>;
}

export function SevMini({ summary = {} }) {
  return (
    <span className="sec-sevmini">
      {SEVERITIES.filter((k) => summary[k]).map((k) => (
        <span key={k} className="sec-sev" data-sev={k} aria-label={`${summary[k]} ${sevLabel(k).toLowerCase()}`}>{summary[k]}</span>
      ))}
    </span>
  );
}

/** Severity filter pills under a donut: <SevFilter summary active onToggle onClear what="vulnerabilities" /> */
export function SevFilter({ summary = {}, active, onToggle, onClear, what }) {
  return (
    <div className="sec-sevfilter" role="group" aria-label={`Filter ${what} by severity`}>
      {SEVERITIES.filter((k) => summary[k]).map((k) => (
        <button
          key={k}
          type="button"
          className={`sec-sevfilter-pill sec-sev ${active === k ? 'active' : ''}`}
          data-sev={k}
          aria-pressed={active === k}
          onClick={() => onToggle(k)}
        >
          <i className="sec-sev-swatch" aria-hidden="true" />
          {sevLabel(k)}
          <b>{summary[k]}</b>
        </button>
      ))}
      {active && <button type="button" className="sec-sevfilter-clear" onClick={onClear}>Clear</button>}
    </div>
  );
}
