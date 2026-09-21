import Icon from '../Icons';
import Button from './Button';
import { errorMessage } from '../../lib/api';

/** <ErrorState error={err} onRetry={refetch} title="Couldn't load pods" /> */
export default function ErrorState({ error, onRetry, title = 'Something went wrong', retryLabel = 'Retry', busy = false, compact = false, className = '' }) {
  const msg = typeof error === 'string' ? error : errorMessage(error, '');
  const status = error && typeof error === 'object' ? error.status : undefined;
  return (
    <div className={`ui-error ${className}`.trim()} data-compact={compact || undefined} role="alert">
      <span className="ui-error-icon" aria-hidden="true"><Icon name="warning" size={compact ? 16 : 26} /></span>
      <div className="ui-error-body">
        <p className="ui-error-title">{title}</p>
        {msg && <p className="ui-error-msg">{msg}{status ? <span className="ui-error-status"> (HTTP {status})</span> : null}</p>}
        {onRetry && (
          <div className="ui-error-action">
            <Button variant="secondary" size="sm" icon="refresh" onClick={onRetry} busy={busy}>{retryLabel}</Button>
          </div>
        )}
      </div>
    </div>
  );
}

export { ErrorState };
