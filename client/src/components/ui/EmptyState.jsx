import Icon from '../Icons';

/** <EmptyState icon="pod" title="No pods" hint="Try another namespace" action={<Button…/>} /> */
export default function EmptyState({ icon = 'box', title, hint, action, size = 'md', className = '' }) {
  return (
    <div className={`ui-empty ${className}`.trim()} data-size={size} role="status">
      {icon && <span className="ui-empty-icon" aria-hidden="true"><Icon name={icon} size={size === 'sm' ? 22 : 34} strokeWidth={1.5} /></span>}
      {title && <p className="ui-empty-title">{title}</p>}
      {hint && <p className="ui-empty-hint">{hint}</p>}
      {action && <div className="ui-empty-action">{action}</div>}
    </div>
  );
}

export { EmptyState };
