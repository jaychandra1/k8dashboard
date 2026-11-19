import Icon from '../Icons';
import Button from './Button';
import { errorMessage } from '../../lib/api';

/**
 * <ErrorState error={err} onRetry={refetch} title="Couldn't load pods" />
 *
 * An answer of "you aren't allowed to" (code 'forbidden') is not a failure:
 * it is shown without the alarm — no warning sign, no HTTP status — with the
 * server's sentence saying what isn't allowed. A title that words a failure
 * ("Couldn't load nodes") becomes "No access"; a caller that words the refusal
 * itself ("Your RBAC role can't read …", shared/errors.js) keeps its title.
 */
const FAILURE_TITLE = /^(Couldn['’]t load|Something went wrong|Latest refresh failed)/;
export default function ErrorState({ error, onRetry, title = 'Something went wrong', retryLabel = 'Retry', busy = false, compact = false, className = '' }) {
  const msg = typeof error === 'string' ? error : errorMessage(error, '');
  const denied = !!error && typeof error === 'object' && error.code === 'forbidden';
  const status = !denied && error && typeof error === 'object' ? error.status : undefined;
  const shownTitle = denied && FAILURE_TITLE.test(title) ? 'No access' : title;
  return (
    <div className={`ui-error ${className}`.trim()} data-compact={compact || undefined} data-denied={denied || undefined} role={denied ? 'status' : 'alert'}>
      <span className="ui-error-icon" aria-hidden="true"><Icon name={denied ? 'shield' : 'warning'} size={compact ? 16 : 26} /></span>
      <div className="ui-error-body">
        <p className="ui-error-title">{shownTitle}</p>
        {msg && <p className="ui-error-msg">{msg}{status ? <span className="ui-error-status"> (HTTP {status})</span> : null}</p>}
        {onRetry && (
          <div className="ui-error-action">
            <Button variant="secondary" size="sm" icon="refresh" onClick={onRetry} busy={busy}>{denied ? 'Check again' : retryLabel}</Button>
          </div>
        )}
      </div>
    </div>
  );
}

export { ErrorState };
