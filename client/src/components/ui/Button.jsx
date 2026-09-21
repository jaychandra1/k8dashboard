import { forwardRef } from 'react';
import Icon from '../Icons';

/**
 * <Button variant="primary|secondary|ghost|danger" size="sm|md|lg" icon="refresh" iconOnly ariaLabel busy />
 * Always renders <button type="button"> (pass type="submit" explicitly for forms).
 * `ariaLabel` is required when `iconOnly` (dev-time warning otherwise).
 */
const Button = forwardRef(function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconSize,
  iconOnly = false,
  ariaLabel,
  busy = false,
  disabled,
  className = '',
  children,
  type = 'button',
  ...rest
}, ref) {
  if (iconOnly && !ariaLabel && import.meta.env?.DEV) {
    console.warn('<Button iconOnly> requires ariaLabel');
  }
  const isDisabled = disabled || busy;
  const iconPx = iconSize || (size === 'sm' ? 13 : size === 'lg' ? 17 : 15);
  return (
    <button
      ref={ref}
      type={type}
      className={`ui-btn ${className}`.trim()}
      data-variant={variant}
      data-size={size}
      data-icon-only={iconOnly || undefined}
      data-busy={busy || undefined}
      aria-label={ariaLabel}
      aria-busy={busy || undefined}
      disabled={isDisabled}
      title={iconOnly ? (rest.title ?? ariaLabel) : rest.title}
      {...rest}
    >
      {busy ? <span className="ui-btn-spinner" aria-hidden="true" /> : (icon ? <Icon name={icon} size={iconPx} /> : null)}
      {!iconOnly && children != null && <span className="ui-btn-label">{children}</span>}
    </button>
  );
});

export default Button;
export { Button };
