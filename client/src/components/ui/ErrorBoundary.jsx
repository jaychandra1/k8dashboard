import React from 'react';
import ErrorState from './ErrorState';

/**
 * Catches render errors below it. `resetKey` (e.g. the current view) resets the
 * boundary when it changes so navigating away recovers automatically.
 *
 *   <ErrorBoundary resetKey={route.view} fallback={(err, reset) => …}>…</ErrorBoundary>
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.reset = this.reset.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info?.componentStack);
    this.props.onError?.(error, info);
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) this.reset();
  }

  reset() {
    this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (typeof this.props.fallback === 'function') return this.props.fallback(error, this.reset);
    if (this.props.fallback) return this.props.fallback;
    return (
      <div className="ui-boundary">
        <ErrorState
          title={this.props.title || 'This view crashed'}
          error={error}
          onRetry={this.reset}
          retryLabel="Reload view"
        />
      </div>
    );
  }
}

export { ErrorBoundary };
