// Branded loading screen: a glass tile with a Kubernetes-style helm turning in
// it (still under prefers-reduced-motion), "Getting the data…" (+ cluster name
// when known) and a thin indeterminate bar. Announced once via role=status.
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

// The helm: a rim, a hub and seven spokes that reach past the rim, drawn in a
// 100-unit box. Drawn here (not an image) so it stays sharp at any size and
// costs nothing to load.
const SPOKES = Array.from({ length: 7 }, (_, i) => {
  const a = ((-90 + (i * 360) / 7) * Math.PI) / 180;
  const at = (r) => [(50 + r * Math.cos(a)).toFixed(2), (50 + r * Math.sin(a)).toFixed(2)];
  const [x1, y1] = at(13);
  const [x2, y2] = at(44);
  return { x1, y1, x2, y2 };
});

export function HelmWheel({ size = 56, className = '' }) {
  return (
    <svg className={className} viewBox="0 0 100 100" width={size} height={size} fill="none" stroke="currentColor" strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="50" cy="50" r="27" strokeWidth="8" />
      {SPOKES.map((s, i) => <line key={i} {...s} strokeWidth="7" />)}
      <circle cx="50" cy="50" r="7.5" strokeWidth="6" />
    </svg>
  );
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
      <span className="loading-mark" aria-hidden="true">
        <HelmWheel className="loading-wheel" />
      </span>
      <p className="loading-screen-text">{text}</p>
      {hint && <p className="loading-screen-hint">{hint}</p>}
      {steps && (
        <ol className="loading-steps" aria-label="Connection steps">
          {steps.map((s, i) => {
            const state = i < at ? 'done' : i === at ? 'current' : 'pending';
            return (
              <li key={s.key} data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
                <span className="loading-step-mark" aria-hidden="true">
                  {state === 'done' && (
                    <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 8.5 6.6 11.5 12.5 5" /></svg>
                  )}
                </span>
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
