import { statusTone } from '../../lib/status';

/**
 * <Badge tone="ok|warn|bad|muted|info">Running</Badge>
 * or <Badge status="CrashLoopBackOff" kind="pod" /> (tone derived, text = status).
 * Renders a coloured dot + the text, so status is never conveyed by colour alone.
 */
export default function Badge({ tone, status, kind, dot = true, size, className = '', children, title, ...rest }) {
  const t = tone || (status != null ? (kind ? statusTone(kind, status) : statusTone(status)) : 'muted');
  const text = children ?? status ?? '';
  return (
    <span className={`ui-badge ${className}`.trim()} data-tone={t} data-size={size} title={title} {...rest}>
      {dot && <span className="ui-badge-dot" aria-hidden="true" />}
      <span className="ui-badge-text">{text}</span>
    </span>
  );
}

export { Badge };

/** Bare status dot with accessible text: <StatusDot tone="ok" label="Running" /> */
export function StatusDot({ tone = 'muted', label, className = '' }) {
  return (
    <span className={`status-dot ${className}`.trim()} data-tone={tone} role="img" aria-label={label} title={label} />
  );
}
