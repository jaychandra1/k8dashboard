// Branded loading screen: the detailed K8Board artwork (gentle pulse, off
// under prefers-reduced-motion), "Getting the data…" (+ cluster name when
// known) and a thin indeterminate bar. Announced once via role=status.
// Used at startup, over <main> during a context switch, and by the Cluster
// page while its summary loads.
//
//   <LoadingScreen />                                  startup (no context yet)
//   <LoadingScreen context="dev-env-cluster" />        "Getting the data from dev-env-cluster…"
//   <LoadingScreen context hint="Checking cluster authentication…" />
//   <LoadingScreen overlay context />                  absolutely covers its positioned parent (main)
//
// `overlay` covers only the region it is rendered in (App renders it inside
// <main>, so the sidebar and top bar stay usable); it is not a modal.
export function loadingText(context) {
  return context ? `Getting the data from ${context}…` : 'Getting the data…';
}

// Connecting to a cluster: `steps` ([{ key, label }]) are listed with the
// current one (`step`) marked, and `onCancel` adds a Cancel button.
//   <LoadingScreen context="dev" label="Connecting to dev…" steps={CONNECT_STEPS} step="auth" onCancel={…} />
export default function LoadingScreen({ context, label, hint, overlay = false, className = '', steps, step, onCancel }) {
  const text = label || loadingText(context);
  const at = steps ? Math.max(0, steps.findIndex((s) => s.key === step)) : -1;
  return (
    <div
      className={`loading-screen ${className}`.trim()}
      data-overlay={overlay || undefined}
      role="status"
      aria-live="polite"
    >
      <img className="loading-screen-logo" src="/logo-detailed.png" alt="" width={120} height={120} decoding="async" />
      <p className="loading-screen-text">{text}</p>
      {hint && <p className="loading-screen-hint">{hint}</p>}
      {steps && (
        <ol className="loading-steps" aria-label="Connection steps">
          {steps.map((s, i) => {
            const state = i < at ? 'done' : i === at ? 'current' : 'pending';
            return (
              <li key={s.key} data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
                <span className="loading-step-mark" aria-hidden="true">{state === 'done' ? '✓' : ''}</span>
                {s.label}
              </li>
            );
          })}
        </ol>
      )}
      <div className="loading-screen-bar" aria-hidden="true"><span /></div>
      {onCancel && (
        <button type="button" className="ui-btn loading-cancel" data-variant="secondary" data-size="sm" onClick={onCancel}>Cancel</button>
      )}
    </div>
  );
}

export { LoadingScreen };
